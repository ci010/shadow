// Only this disposable Node child loads native code, never Shadow/Electron main.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import { Worker, isMainThread, parentPort } from 'node:worker_threads'
import { nativeResponse } from './agent-desktop-errors.js'
import { ComputerActionSchema } from './agent-desktop-actions.js'

const uuid = z.string().uuid()
const target = { targetId: uuid }
const requestSchema = z.discriminatedUnion('method', [
  z.object({ id: uuid, method: z.literal('list'), processId: z.number().int().positive().optional() }).strict(),
  z.object({ id: uuid, method: z.literal('bind'), windowId: uuid }).strict(),
  z.object({ id: uuid, method: z.literal('observe'), ...target, screenshot: z.boolean() }).strict(),
  z.object({ id: uuid, method: z.literal('act'), ...target, observationId: uuid, actionId: uuid, action: ComputerActionSchema }).strict(),
  z.object({ id: uuid, method: z.literal('release'), ...target }).strict(),
])
const identitySchema = z.object({
  protocol: z.literal(1), backend: z.literal('agent-desktop'),
  revision: z.literal('5a2c9ad43e269164a8adc8978a733c40b1d38a8b'),
  capabilities: z.object({
    restricted: z.literal(true), patch: z.literal('shadow-password-first-v4'),
    methods: z.tuple([z.literal('list'), z.literal('bind'), z.literal('observe'), z.literal('act'), z.literal('release')]),
    actions: z.tuple(['invoke', 'set_value', 'toggle', 'select', 'scroll', 'click', 'move', 'drag', 'wheel', 'press_key', 'type_text'].map(value => z.literal(value))),
    screenshot: z.literal(true), input: z.literal(true), clipboard: z.literal(false),
    values: z.literal(true), nodeBounds: z.literal(true), guard: z.literal('shadow-input-guard-v1'),
  }).strict(),
}).strict()
const guardPath = fileURLToPath(new URL(`../../../integrations/agent-desktop/artifacts/win32-${process.arch}/shadow-input-guard.exe`, import.meta.url))
let addon
function load() {
  if (addon) return addon
  if (process.platform !== 'win32' || !['x64', 'arm64'].includes(process.arch)) throw Error('unsupported platform')
  const path = fileURLToPath(new URL(`../../../integrations/agent-desktop/artifacts/win32-${process.arch}/shadow-agent-desktop.node`, import.meta.url))
  const loaded = createRequire(import.meta.url)(path)
  if (typeof loaded.request !== 'function' || typeof loaded.identity !== 'function' || typeof loaded.cancelInput !== 'function') throw Error('invalid addon')
  identitySchema.parse(JSON.parse(loaded.identity()))
  addon = loaded
  return addon
}

if (!isMainThread) {
  parentPort.on('message', request => {
    if (request.type === 'shutdown') {
      try { if (addon) addon.request(JSON.stringify({ method: 'shutdown' })) } catch { /* bounded process exit is the fallback */ }
      parentPort.postMessage({ closed: true })
      return
    }
    let native
    try { native = load() }
    catch { parentPort.postMessage({ id: request.id, body: { error: { code: 'host_failure' } } }); return }
    try {
      const { id, ...command } = request
      const body = nativeResponse.parse(JSON.parse(native.request(JSON.stringify({ ...command, ownerPid: process.ppid, guardPath }))))
      parentPort.postMessage({ id, body })
    } catch {
      parentPort.postMessage({ id: request.id, body: { error: { code: request.method === 'act' ? 'outcome_unknown' : 'host_failure' } }, fatal: true })
    }
  })
} else {
  let active, closing = false, exitCode = 0, shutdownRequested = false
  const thread = new Worker(new URL(import.meta.url), { execArgv: [] })
  function finish() {
    if (process.stdout.destroyed) process.exit(exitCode)
    process.stdout.end(() => process.exit(exitCode))
  }
  function shutdown() {
    if (!shutdownRequested && !active) {
      shutdownRequested = true
      try { thread.postMessage({ type: 'shutdown' }) } catch { /* cancellation watchdog remains active */ }
    }
  }
  function stop(code = 0) {
    exitCode = Math.max(exitCode, code)
    if (closing) return
    closing = true
    // No request()/COM on this isolate. This quick signal remains usable while
    // the JS Worker/native owner is blocked in a provider or guard IPC.
    try { addon?.cancelInput() } catch { exitCode = 2 }
    shutdown()
    // Independent guard cancellation has a 1500ms watchdog; leave cleanup time
    // before the parent supervisor's 2000ms kill.
    setTimeout(() => process.exit(exitCode), 1600)
  }
  function reply(id, body) {
    const text = JSON.stringify({ id, ...body }) + '\n'
    if (Buffer.byteLength(text) > 6 * 1024 * 1024) { stop(2); return }
    process.stdout.write(text)
  }
  thread.on('message', ({ id, body, fatal, closed }) => {
    if (closed) { finish(); return }
    if (id !== active) { stop(2); return }
    active = undefined
    if (closing) { shutdown(); return }
    reply(id, body)
    if (fatal) stop(2)
  })
  thread.on('error', () => stop(2))
  thread.on('exit', () => { if (!closing) stop(2) })
  let buffer = Buffer.alloc(0)
  process.stdin.on('data', chunk => {
    if (closing) return
    buffer = Buffer.concat([buffer, chunk])
    if (buffer.length > 64 * 1024) { stop(2); return }
    let end
    while ((end = buffer.indexOf(10)) >= 0) {
      const line = buffer.subarray(0, end)
      buffer = buffer.subarray(end + 1)
      let request
      try { request = requestSchema.parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line))) }
      catch { stop(2); return }
      if (active) { stop(2); return } // never queue overlapping operations
      try { load() } // identity/control only; never desktop/COM request on this isolate
      catch { reply(request.id, { error: { code: 'host_failure' } }); continue }
      active = request.id
      thread.postMessage(request)
    }
  })
  process.stdin.on('end', () => stop())
  process.stdin.on('error', () => stop(2))
  process.stdout.on('error', () => stop(2))
  process.on('uncaughtException', () => stop(2))
  process.on('unhandledRejection', () => stop(2))
}
