import vm from 'node:vm'
import { stripTypeScriptTypes } from 'node:module'
import { pathToFileURL } from 'node:url'
import { types } from 'node:util'
import { registerTypeScriptLoader } from '../utils/typescript.ts'
import { checkTextSize, decodeJson, encodeJson } from './json-boundary.ts'
import {
  callFailureMessage, ParentPacketSchema, validateImports,
  type CallFailure, type ChildPacket, type ParentPacket,
} from './protocol.ts'

let started = false
let failed = false
let completed = false
let host = false
let testDiagnostics = false
let idleScript = false
let calls = 0
const pending = new Map<number, { resolve: (json: string) => void; reject: (error: Error) => void }>()
const callFailures = new WeakMap<object, CallFailure>()

function send(packet: ChildPacket): void {
  if (!process.connected) return
  process.send!(packet, error => { if (error) process.exit(1) })
}

function fail(code: Extract<ChildPacket, { type: 'error' }>['code'], error?: unknown): void {
  if (failed || completed) return
  failed = true
  const failure = error && typeof error === 'object' ? callFailures.get(error) : undefined
  send({
    type: 'error', code: failure ? 'capability_failed' : code,
    ...(failure ? { failure } : {}),
    ...(host && types.isNativeError(error) ? { message: error.message.slice(0, 4096) } : {}),
    ...(testDiagnostics && code === 'guest_failed' && !failure && types.isNativeError(error)
      ? { diagnostic: `${error.name}: ${error.message}`.slice(0, 4096) } : {}),
  })
}

process.on('disconnect', () => process.exit(0))
process.on('uncaughtException', error => fail('guest_failed', error))
process.on('unhandledRejection', error => fail('guest_failed', error))

async function execute(packet: Extract<ParentPacket, { type: 'start' }>): Promise<void> {
  host = packet.policy.kind === 'host'
  testDiagnostics = packet.policy.kind === 'restricted' && packet.policy.mode === 'test'
  // Windows/libuv may insert profile/PATH variables despite an explicit env.
  const environmentKeys = new Set(packet.envKeys.map(key => key.toUpperCase()))
  for (const key of Object.keys(process.env)) {
    if (!environmentKeys.has(key.toUpperCase())) delete process.env[key]
  }
  checkTextSize(packet.code, 'source')
  decodeJson(packet.args, 'input')
  const allowed = new Set(packet.policy.kind === 'restricted'
    ? validateImports(packet.policy.imports, packet.policy.mode)
    : packet.toolNames.map(name => `@shadow/${name}`))
  const sandbox = Object.create(null) as Record<string, unknown>
  if (host) {
    registerTypeScriptLoader()
    // Preserve Node's web APIs and normal host globals without replacing the VM
    // realm's intrinsic prototypes (JSON inputs/outputs remain plain data).
    const intrinsics = new Set(vm.runInNewContext('Object.getOwnPropertyNames(globalThis)') as string[])
    for (const key of Object.getOwnPropertyNames(globalThis)) {
      if (!intrinsics.has(key) || key === 'console') {
        Object.defineProperty(sandbox, key, Object.getOwnPropertyDescriptor(globalThis, key)!)
      }
    }
    sandbox.global = sandbox
  } else {
    sandbox.console = undefined
  }
  const context = vm.createContext(sandbox, {
    name: 'script', codeGeneration: { strings: host, wasm: host },
  })
  const realm = vm.runInContext('({ object: Object.prototype, array: Array.prototype })', context) as {
    object: object; array: object
  }
  const parse = vm.runInContext('JSON.parse', context) as (text: string) => unknown
  const modules = new Map<string, Promise<vm.SyntheticModule>>()
  const loads = new Map<vm.Module, Promise<void>>()
  const call = async (name: string, input: unknown = {}): Promise<unknown> => {
    if (failed || completed) throw new Error('Execution ended.')
    if (++calls > packet.maxCalls) {
      fail('capability_limit')
      throw new Error('Module call limit exceeded.')
    }
    let json: string
    try {
      json = encodeJson(input, 'module input', true, realm)
    } catch {
      fail('invalid_json')
      throw new Error('Invalid module input.')
    }
    const id = calls
    process.channel?.ref()
    const result = new Promise<string>((resolve, reject) => pending.set(id, { resolve, reject }))
    send({ type: 'call', id, name, json })
    return parse(await result)
  }
  if (host) {
    const globals: Record<string, unknown> = {
      pipe: async (value: unknown, ...fns: Array<(value: unknown) => unknown>) => {
        let result = await value
        for (const fn of fns) result = await fn(result)
        return result
      },
      json: (value: unknown) => typeof value === 'string' ? JSON.parse(value) : value,
      lines: (value: string) => value.split('\n').filter(Boolean),
      map: (array: unknown[], fn: (value: unknown, index: number) => unknown) => Promise.all(array.map(fn)),
      pick: (value: Record<string, unknown>, key: string) => value[key],
      flat: (value: unknown[]) => value.flat(),
      filter: (array: unknown[], fn: (value: unknown) => boolean) => array.filter(fn),
      join: (value: unknown[], separator = '\n') => value.join(separator),
      count: (value: unknown[] | string) => value.length,
    }
    for (const name of packet.toolNames) {
      if (name in globals || name in globalThis || name === 'arguments') continue
      globals[name] = (input: unknown = {}) => call(name, input)
    }
    Object.assign(sandbox, globals)
    Object.assign(globalThis, globals)
  }
  const identifier = pathToFileURL(packet.filename).href
  const resolveModule = async (specifier: string): Promise<vm.SyntheticModule> => {
    if ((!host || specifier.startsWith('@shadow/')) && !allowed.has(specifier)) {
      fail('import_denied')
      throw new Error('Import denied.')
    }
    let existing = modules.get(specifier)
    if (!existing) {
      existing = (async () => {
        if (specifier.startsWith('@shadow/')) {
          const invoke = (input: unknown) => call(specifier.slice('@shadow/'.length), input)
          const fetchFactory = vm.runInContext(
            '(invoke) => (path, options = {}) => { if (typeof path !== "string" || !options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("fetch requires a path and options object"); return invoke({ ...options, path, method: options.method ?? "GET" }) }',
            context,
          ) as (sendRequest: (input: unknown) => Promise<unknown>) =>
            (path: string, options?: Record<string, unknown>) => Promise<unknown>
          const fetch = fetchFactory(invoke)
          const exports = specifier === '@shadow/fetch' ? ['default', 'call', 'fetch'] : ['default', 'call']
          return new vm.SyntheticModule(exports, function () {
            this.setExport('default', invoke)
            this.setExport('call', invoke)
            if (specifier === '@shadow/fetch') this.setExport('fetch', fetch)
          }, { context, identifier: specifier })
        }
        const resolved = host ? import.meta.resolve(specifier, identifier) : specifier
        const native = await import(resolved) as Record<string, unknown>
        return new vm.SyntheticModule(Object.keys(native), function () {
          for (const key of Object.keys(native)) this.setExport(key, native[key])
        }, { context, identifier: resolved })
      })()
      modules.set(specifier, existing)
    }
    return existing
  }
  const dynamicImport = async (specifier: string): Promise<vm.Module> => {
    const module = await resolveModule(specifier)
    let load = loads.get(module)
    if (!load) {
      load = (async () => {
        if (module.status === 'unlinked') await module.link(resolveModule)
        if (module.status === 'linked') await module.evaluate()
      })()
      loads.set(module, load)
    }
    await load
    return module
  }
  const code = /\.(?:ts|mts)$/i.test(packet.filename)
    ? stripTypeScriptTypes(packet.code, { mode: host ? 'transform' : 'strip', sourceUrl: identifier })
    : packet.code
  const source = new vm.SourceTextModule(code, {
    context, identifier, importModuleDynamically: dynamicImport,
    initializeImportMeta: meta => {
      meta.url = identifier
      if (host) {
        meta.filename = packet.filename
        meta.resolve = (specifier: string) => import.meta.resolve(specifier, identifier)
      }
    },
  })
  await source.link(resolveModule)
  await source.evaluate()
  if (failed) return
  const namespace = source.namespace as { run?: unknown; default?: unknown; main?: unknown }
  const run = namespace.run ?? namespace.default ?? (packet.entry === 'script' ? namespace.main : undefined)
  if (typeof run !== 'function' && packet.entry === 'run') {
    fail('invalid_entry')
    return
  }
  const result: unknown = typeof run === 'function' ? await run(parse(packet.args)) : null
  if (failed) return
  let json: string
  try {
    json = encodeJson(result === undefined && packet.entry === 'script' ? null : result, 'output', false, realm)
  } catch {
    fail('invalid_json')
    return
  }
  const complete = () => {
    if (failed || completed) return
    completed = true
    send({ type: 'result', json })
  }
  if (host && packet.entry === 'script' && typeof run !== 'function') {
    // IPC itself must not keep a top-level daemon alive, but pending tool calls
    // must. Real timers/sockets keep it running until they finish or cancellation.
    idleScript = true
    process.once('beforeExit', complete)
    if (!pending.size) process.channel?.unref()
  } else {
    complete()
  }
}

process.on('message', raw => {
  if (failed || completed) return
  try {
    const packet = ParentPacketSchema.parse(raw)
    if (packet.type === 'start') {
      if (started) {
        fail('protocol_error')
        return
      }
      started = true
      void execute(packet).catch(error => fail('guest_failed', error))
    } else {
      const callback = pending.get(packet.id)
      if (!started || !callback) {
        fail('protocol_error')
        return
      }
      pending.delete(packet.id)
      if (packet.type === 'response') {
        decodeJson(packet.json, 'module response')
        callback.resolve(packet.json)
      } else {
        const error = new Error(host && packet.failure.message ? packet.failure.message : callFailureMessage(packet.failure))
        Object.assign(error, {
          code: packet.failure.code,
          ...(packet.failure.status !== undefined ? { status: packet.failure.status } : {}),
        })
        callFailures.set(error, packet.failure)
        callback.reject(error)
      }
      if (idleScript && !pending.size) process.channel?.unref()
    }
  } catch {
    fail('protocol_error')
  }
})
