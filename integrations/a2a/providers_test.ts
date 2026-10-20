import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess } from 'node:child_process'
import { SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { withTempWorkspace } from '../../src/testing/workspace.ts'
import { A2aStore } from '../../src/a2a/store.ts'
import { A2aService } from '../../src/a2a/service.ts'
import { CodingBridgeConfigSchema, bridgeEnvironment } from './config.ts'
import { codingRunner, resolveCli, runCli, type SpawnCli } from './providers.ts'
import { startCodingBridge } from './cli.ts'
import { CodingContexts } from './contexts.ts'

const owner = new ServerCallContext({ user: { isAuthenticated: true, userName: 'caller' } })
const request = (text: string, contextId?: string) => SendMessageRequest.fromJSON({ message: { messageId: randomUUID(), role: 'ROLE_USER', parts: [{ text }], contextId } })
const configFor = (root: string, type: 'claude' | 'codex' | 'copilot') => {
  const cwd = join(root, 'work'); mkdirSync(cwd, { recursive: true })
  return CodingBridgeConfigSchema.parse({ projectId: 'p', stateDirectory: join(root, 'state'), cwd, executable: process.execPath, port: 39000,
    server: { url: 'http://127.0.0.1:39000/projects/p/a2a', callers: { caller: 'A2A_BRIDGE_FIXTURE_TOKEN' } }, backend: { type } })
}
function processFixture(output: string, code = 0, check?: (text: string) => void): SpawnCli {
  return (_file, _args, options) => {
    assert.equal(options.shell, false)
    const child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { return true } })
    let input = ''; child.stdin.on('data', chunk => { input += chunk })
    child.stdin.on('finish', () => { check?.(input); child.stdout.write(output); child.emit('close', code) })
    return child as unknown as ChildProcess
  }
}
for (const type of ['claude', 'codex'] as const) {
  test(`${type} launches user CLI, parses completion, scopes resume and policy`, async () => {
    await withTempWorkspace(async root => {
      const config = configFor(root, type); let native: string = randomUUID(); const calls: string[][] = []
      let fail = false
      let wrongSession = false
      const launch: SpawnCli = (file, args, options) => {
        if (type === 'claude' && args.includes('--session-id')) native = args[args.indexOf('--session-id') + 1]
        calls.push(args); assert.equal(file, process.execPath); assert.equal(options.cwd, config.cwd)
        if (type === 'codex') assert.equal(options.env?.CODEX_HOME, join(config.stateDirectory, 'codex'))
        const output = type === 'claude' ? JSON.stringify({ type: 'result', subtype: 'success', is_error: false, session_id: wrongSession ? randomUUID() : native, result: 'done', permission_denials: fail ? [{}] : [] }) : [
          { type: 'thread.started', thread_id: wrongSession ? randomUUID() : native }, { type: 'item.completed', item: { type: 'agent_message', text: 'done' } }, { type: fail ? 'turn.failed' : 'turn.completed' },
        ].map(value => JSON.stringify(value)).join('\n')
        return processFixture(output, 0, text => assert.equal(text, 'untrusted & | text'))(file, args, options)
      }
      const store = new A2aStore(config.stateDirectory); store.init()
      const service = new A2aService('p', { ...config.server, agentType: type }, store, codingRunner(config, launch, () => undefined))
      try {
        const first = await service.sendMessage(request('untrusted & | text'), owner)
        assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED)
        const record = store.inbound.get(first.id)!
        assert.throws(() => new CodingContexts(config).get({ ...record, owner: 'other' }), /owner or policy/)
        assert.throws(() => new CodingContexts({ ...config, executable: join(root, 'different') }).get(record), /owner or policy/)
        const resumed = await service.sendMessage(request('untrusted & | text', first.contextId), owner)
        assert.equal(resumed.status?.state, TaskState.TASK_STATE_COMPLETED)
        assert.equal(resumed.artifacts?.[0]?.parts?.[0]?.content?.value, 'done')
        wrongSession = true
        const unexpected = await service.sendMessage(request('untrusted & | text', first.contextId), owner)
        assert.equal(unexpected.status?.state, TaskState.TASK_STATE_FAILED)
        assert.deepEqual(unexpected.artifacts, [])
        assert.equal(new CodingContexts(config).get(record), native)
        wrongSession = false
        fail = true
        const second = await service.sendMessage(request('untrusted & | text', first.contextId), owner)
        assert.equal(second.status?.state, TaskState.TASK_STATE_FAILED)
        assert.deepEqual(second.artifacts, [])
        assert(calls[1].includes(native)); assert(!calls[0].includes('untrusted & | text'))
        if (type === 'claude') {
          assert(calls[0].includes('dontAsk')); assert(calls[0].includes('--strict-mcp-config')); assert(calls[0].includes('--disable-slash-commands'))
          assert.equal(calls[0][calls[0].indexOf('--tools') + 1], '')
        } else { assert(calls[0].includes('approval_policy="never"')); assert(calls[0].includes('web_search="disabled"')) }
      } finally { await service.close() }
    })
  })
}
test('Copilot fails at startup without launching a permissive CLI', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'copilot')
    await assert.rejects(startCodingBridge(config, () => { throw new Error('must not spawn') }), /Copilot CLI bridge is unsupported/)
  })
})
test('CLI nonzero, malformed, missing completion and output overflow fail closed', async () => {
  await assert.rejects(runCli('fake', [], {}, '', new AbortController().signal, processFixture('secret', 1)), /exited unsuccessfully/)
  await withTempWorkspace(async root => {
    for (const output of ['not json', '{}', '{"type":"thread.started","thread_id":"x"}']) {
      const config = configFor(root, 'codex'); const store = new A2aStore(config.stateDirectory); store.init()
      const service = new A2aService('p', { ...config.server, agentType: 'codex' }, store, codingRunner(config, processFixture(output), () => undefined))
      try { assert.equal((await service.sendMessage(request('work'), owner)).status?.state, TaskState.TASK_STATE_FAILED) } finally { await service.close() }
    }
  })
  await assert.rejects(runCli('fake', [], {}, '', new AbortController().signal, processFixture('x'.repeat(8 * 1024 * 1024 + 1))), /output limit/)
})
test('cancellation waits for subprocess close', async () => {
  const controller = new AbortController(); let child: ChildProcess | undefined; let killed = false; let finished = false
  const launch: SpawnCli = () => {
    child = Object.assign(new EventEmitter(), { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kill() { killed = true; return true } }) as unknown as ChildProcess
    return child
  }
  const pending = runCli('fake', [], {}, '', controller.signal, launch).finally(() => { finished = true })
  controller.abort(new Error('cancelled')); await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(killed, true); assert.equal(finished, false)
  child!.emit('close', null)
  await assert.rejects(pending, /cancelled/)
})
test('configuration and executable resolution reject unsafe inputs; environment is opt-in', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'codex')
    assert.throws(() => CodingBridgeConfigSchema.parse({ ...config, executable: 'codex & whoami' }))
    assert.throws(() => CodingBridgeConfigSchema.parse({ ...config, backend: { type: 'codex', sandbox: 'danger-full-access' } }))
    assert.throws(() => resolveCli({ ...config, executable: join(root, 'missing') }, {}), /not found/)
    assert.equal(resolveCli(config, {}).file, process.execPath)
    process.env.A2A_PRIVATE_FIXTURE = 'private'
    try { assert.equal(bridgeEnvironment([]).A2A_PRIVATE_FIXTURE, undefined); assert.equal(bridgeEnvironment(['A2A_PRIVATE_FIXTURE']).A2A_PRIVATE_FIXTURE, 'private') } finally { delete process.env.A2A_PRIVATE_FIXTURE }
  })
})

test('real harmless subprocess uses stdin and cancellation reaps process tree', { timeout: 10_000 }, async () => {
  const { spawnCli } = await import('./providers.ts')
  const text = 'not shell syntax: & | $(false) 中文'
  const output = await runCli(process.execPath, ['-e', 'process.stdin.setEncoding("utf8");let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>process.stdout.write(text))'], {}, text, new AbortController().signal, spawnCli)
  assert.equal(output, text)
  const controller = new AbortController()
  const entered = Promise.withResolvers<void>()
  const pending = runCli(process.execPath, ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)'], {}, '', controller.signal, (file, args, options) => {
    const child = spawnCli(file, args, options)
    child.stdout!.once('data', () => entered.resolve())
    return child
  })
  await entered.promise
  controller.abort(new Error('cancel test'))
  await assert.rejects(pending, /cancel test/)
  await assert.rejects(runCli(join(process.cwd(), 'nonexistent-a2a-fixture'), [], {}, '', new AbortController().signal, spawnCli), /ENOENT/)
})

test('loopback bridge retains authenticated protocol and releases its state lock', async () => {
  await withTempWorkspace(async root => {
    const prior = process.env.A2A_BRIDGE_FIXTURE_TOKEN
    process.env.A2A_BRIDGE_FIXTURE_TOKEN = 'synthetic-bridge-token-at-least-32-characters'
    const config = configFor(root, 'claude')
    const launch: SpawnCli = (file, args, options) => processFixture(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'loopback', session_id: args[args.indexOf('--session-id') + 1] }))(file, args, options)
    try {
      const bridge = await startCodingBridge({ ...config, port: 0 }, launch)
      try {
        const url = `http://127.0.0.1:${bridge.port}/projects/p/a2a`
        assert.equal((await fetch(`${url}/.well-known/agent-card.json`)).status, 401)
        const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', Authorization: `Bearer ${process.env.A2A_BRIDGE_FIXTURE_TOKEN}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: SendMessageRequest.toJSON(request('work')) }) })
        const result = await response.json()
        assert.equal(result.result.task.status.state, 'TASK_STATE_COMPLETED')
        assert.equal(result.result.task.artifacts[0].parts[0].text, 'loopback')
      } finally { await bridge.close() }
      const reopened = await startCodingBridge({ ...config, port: 0 }, launch)
      await reopened.close()
    } finally {
      if (prior === undefined) delete process.env.A2A_BRIDGE_FIXTURE_TOKEN
      else process.env.A2A_BRIDGE_FIXTURE_TOKEN = prior
    }
  })
})


test('explicit JS and Windows npm shims resolve without running a shell', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'claude')
    const js = join(root, 'cli.js'); writeFileSync(js, '// fixture')
    assert.deepEqual(resolveCli({ ...config, executable: js }, {}), { file: process.execPath, prefix: [js] })
    if (process.platform !== 'win32') return
    const shim = join(root, 'claude.cmd'); writeFileSync(shim, 'must never run this shell script')
    assert.throws(() => resolveCli({ ...config, executable: undefined }, { Path: root }), /shell shim/)
    const entry = join(root, 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js')
    mkdirSync(join(root, 'node_modules', '@anthropic-ai', 'claude-code'), { recursive: true }); writeFileSync(entry, '// fixture')
    assert.deepEqual(resolveCli({ ...config, executable: undefined }, { Path: root }), { file: process.execPath, prefix: [entry] })
  })
})

test('Codex refreshes and deletes bridge auth using only an injected synthetic source', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'codex')
    const source = join(root, 'synthetic-auth.json')
    const copied = join(config.stateDirectory, 'codex', 'auth.json')
    const native = randomUUID()
    let expected: string | undefined
    let reads = 0
    let launches = 0
    const authSource = () => {
      reads++
      return existsSync(source) ? readFileSync(source, 'utf8') : undefined
    }
    const launch: SpawnCli = (file, args, options) => {
      launches++
      assert.equal(options.env?.CODEX_HOME, join(config.stateDirectory, 'codex'))
      assert.equal(existsSync(copied), expected !== undefined)
      if (expected !== undefined) assert.equal(readFileSync(copied, 'utf8'), expected)
      return processFixture([
        { type: 'thread.started', thread_id: native },
        { type: 'item.completed', item: { type: 'agent_message', text: 'synthetic result' } },
        { type: 'turn.completed' },
      ].map(event => JSON.stringify(event)).join('\n'))(file, args, options)
    }
    const store = new A2aStore(config.stateDirectory); store.init()
    const service = new A2aService('p', { ...config.server, agentType: 'codex' }, store, codingRunner(config, launch, authSource))
    try {
      expected = '{"synthetic":"first"}'
      writeFileSync(source, expected)
      const first = await service.sendMessage(request('work'), owner)
      assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED)
      expected = '{"synthetic":"refreshed"}'
      writeFileSync(source, expected)
      assert.equal((await service.sendMessage(request('refresh', first.contextId), owner)).status?.state, TaskState.TASK_STATE_COMPLETED)
      rmSync(source); expected = undefined
      assert.equal((await service.sendMessage(request('deleted', first.contextId), owner)).status?.state, TaskState.TASK_STATE_COMPLETED)
      assert.equal(reads, 3); assert.equal(launches, 3)
      assert.equal(existsSync(copied), false)
    } finally { await service.close() }
  })
})


test('Claude npm shims resolve vetted native and legacy bins without interpreting launcher content', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'claude')
    const shim = join(root, 'claude.cmd')
    const marker = join(root, 'shim-was-executed')
    writeFileSync(shim, `echo unsafe > "${marker}"`)
    const pkgRoot = join(root, 'node_modules', '@anthropic-ai', 'claude-code')
    mkdirSync(join(pkgRoot, 'bin'), { recursive: true })
    const manifest = join(pkgRoot, 'package.json')
    const native = join(pkgRoot, 'bin', 'claude.exe')
    const js = join(pkgRoot, 'cli.js')
    const resolve = () => resolveCli({ ...config, executable: shim }, {})
    const writeManifest = (bin: unknown, name = '@anthropic-ai/claude-code') => writeFileSync(manifest, JSON.stringify({ name, version: '2.1.304', bin }))
    writeFileSync(native, 'fixture only; must not execute')
    writeManifest({ claude: 'bin/claude.exe' })
    assert.deepEqual(resolve(), { file: native, prefix: [] })
    if (process.platform === 'win32') {
      assert.deepEqual(resolveCli({ ...config, executable: undefined }, { Path: root }), { file: native, prefix: [] })
    }
    rmSync(native)
    assert.throws(resolve, /shell shim/)
    writeFileSync(js, '// legacy fixture')
    writeManifest({ claude: 'cli.js' })
    assert.deepEqual(resolve(), { file: process.execPath, prefix: [js] })
    writeManifest('cli.js')
    assert.deepEqual(resolve(), { file: process.execPath, prefix: [js] })
    for (const bin of ['../outside.exe', '/outside.exe', 'bin/launcher.cmd', 'bin/launcher.js', { other: 'cli.js' }, null]) {
      writeManifest(bin)
      assert.throws(resolve, /shell shim/)
    }
    writeManifest({ claude: 'cli.js' }, 'unrelated-package')
    assert.throws(resolve, /shell shim/)
    writeFileSync(manifest, 'invalid json')
    assert.throws(resolve, /shell shim/)
    rmSync(manifest)
    assert.deepEqual(resolve(), { file: process.execPath, prefix: [js] })
    assert.equal(existsSync(marker), false)
  })
})

test('Codex npm shim retains its fixed JS entrypoint', async () => {
  await withTempWorkspace(async root => {
    const config = configFor(root, 'codex')
    const shim = join(root, 'codex.cmd'); writeFileSync(shim, 'must never execute')
    const resolve = () => resolveCli({ ...config, executable: shim }, {})
    assert.throws(resolve, /shell shim/)
    const js = join(root, 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    mkdirSync(join(root, 'node_modules', '@openai', 'codex', 'bin'), { recursive: true })
    writeFileSync(js, '// fixture')
    assert.deepEqual(resolve(), { file: process.execPath, prefix: [js] })
  })
})
