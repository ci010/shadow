import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { A2aSetup } from './setup.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { A2aConfig } from './config.ts'

test('local setup denies non-owner contexts; config is explicit, survives restart stopped, hot target uses private token', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a2a-setup-'))
  const cwd = join(root, 'work'); const bin = join(root, 'bin')
  mkdirSync(cwd); mkdirSync(bin)
  if (process.platform === 'win32') {
    mkdirSync(join(bin, 'node_modules/@openai/codex/bin'), { recursive: true })
    writeFileSync(join(bin, 'codex.cmd'), '@echo off')
    writeFileSync(join(bin, 'node_modules/@openai/codex/bin/codex.js'), 'console.log("codex 1.2.3")')
  } else writeFileSync(join(bin, 'codex'), '#!/bin/sh\necho codex 1.2.3\n', { mode: 0o700 })
  const pathKey = Object.keys(process.env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const previous = process.env[pathKey]; process.env[pathKey] = bin
  const config: A2aConfig = { agents: {} }
  const tokens = new Map<string, string>()
  const setup = new A2aSetup('project', join(root, 'private'), config, (name, token) => { if (token) tokens.set(name, token); else tokens.delete(name) }, () => {})
  const tools = { executionMode: 'session' } as any; tools.dynamicOwner = tools
  const context = { projectId: 'project', admin: true, channel: 'web', cwd, sessionId: 'owner', signal: new AbortController().signal, tools } as ExecutionContext
  const configure = { action: 'configure', name: 'local', cwd, backend: { type: 'codex', sandbox: 'read-only' } }
  try {
    for (const change of [{ admin: false }, { channel: 'a2a' }, { isGroup: true }, { remoteWorkdir: {} }, { projectId: 'other' }]) {
      assert.match(await setup.execute(configure, { ...context, ...change } as ExecutionContext), /error/)
    }
    assert.match(await setup.execute({ ...configure, endpoint: 'https://example.com' }, context), /error/)
    assert.match(await setup.execute({ ...configure, cwd: root }, context), /error/)
    assert.match(await setup.execute({ ...configure, backend: { type: 'codex' } }, context), /error/)
    assert.match(await setup.execute({ action: 'detect', type: 'codex' }, context), /1.2.3/)
    assert.match(await setup.execute(configure, context), /configured-stopped/)
    assert.deepEqual(Object.keys(config.agents), [])
    assert.match(await setup.execute(configure, context), /error/)
    assert.match(await setup.execute({ action: 'start', name: 'local' }, context), /listening/)
    assert.deepEqual(Object.keys(config.agents), ['local'])
    const credential = tokens.get('local')!
    assert.equal(credential.length, 64)
    const target = config.agents.local!
    assert.equal((await fetch(target.cardUrl)).status, 401)
    const response = await fetch(target.cardUrl, { headers: { Authorization: `Bearer ${credential}` } })
    assert.equal(response.status, 200)
    const card = await response.json() as any
    assert.equal(card.supportedInterfaces[0].url, target.endpointUrl)
    assert.ok(!(await setup.execute({ action: 'status', name: 'local' }, context)).includes(credential))
    assert.match(await setup.execute({ action: 'stop', name: 'local' }, context), /stopped/)
    assert.deepEqual(Object.keys(config.agents), [])
    assert.equal(tokens.size, 0)
    const restoredConfig: A2aConfig = { agents: {} }
    const restarted = new A2aSetup('project', join(root, 'private'), restoredConfig, () => {}, () => {})
    assert.match(await restarted.execute({ action: 'status', name: 'local' }, context), /stopped/)
    const { createServer } = await import('node:net')
    const blocker = createServer()
    await new Promise<void>((resolve, reject) => { blocker.once('error', reject); blocker.listen(Number(new URL(target.endpointUrl).port), '127.0.0.1', resolve) })
    try {
      assert.equal(JSON.parse(await restarted.execute({ action: 'start', name: 'local' }, context)).error.code, 'PORT_IN_USE')
      assert.deepEqual(restoredConfig.agents, {})
    } finally { await new Promise<void>((resolve, reject) => blocker.close(error => error ? reject(error) : resolve())) }
    assert.match(await restarted.execute({ action: 'start', name: 'local' }, context), /listening/)
    assert.equal(restoredConfig.agents.local?.endpointUrl, target.endpointUrl)
    assert.equal((await fetch(target.cardUrl, { headers: { Authorization: `Bearer ${credential}` } })).status, 200)
    await restarted.close()
  } finally {
    await setup.close()
    if (previous === undefined) delete process.env[pathKey]; else process.env[pathKey] = previous
    rmSync(root, { recursive: true, force: true })
  }
})

// Synthetic Claude executable: never reads operator auth or invokes an installed CLI.
function synthetic(root: string) {
  const file = join(root, 'fixture.js')
  writeFileSync(file, `
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('fixture 1.2.3'); process.exit(0); }
const resumed = args.includes('--resume');
const id = args[args.indexOf(resumed ? '--resume' : '--session-id') + 1];
let input = ''; process.stdin.on('data', chunk => input += chunk); process.stdin.on('end', () => {
 fs.appendFileSync(path.join(process.cwd(), 'invocations.jsonl'), JSON.stringify({id,resumed,input})+'\\n');
 console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:resumed?'continued':'first',session_id:id}));
});`)
  return file
}
function owner(cwd: string) {
  const tools = { executionMode: 'session', canUseDynamic: () => true, getWorkGuard: () => undefined } as any
  tools.dynamicOwner = tools
  return { projectId: 'project', admin: true, channel: 'web', cwd, sessionId: 'owner', physicalSessionId: 'physical', signal: new AbortController().signal, tools } as ExecutionContext
}

test('configure without first start survives cold reload with unallocated port; explicit executable and safe recovery', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a2a-cold-')); const cwd = join(root, 'work'); mkdirSync(cwd)
  const executable = synthetic(root); const context = owner(cwd); const directory = join(root, 'private')
  const create = () => new A2aSetup('project', directory, { agents: {} }, () => {}, () => {})
  const first = create()
  try {
    assert.equal(JSON.parse(await first.execute({ action: 'detect', type: 'claude', executable }, context)).version, '1.2.3')
    assert.match(await first.execute({ action: 'configure', name: 'cold', cwd, executable, backend: { type: 'claude', tools: [] } }, context), /configured-stopped/)
    await first.close()
    const second = create()
    try {
      const list = JSON.parse(await second.execute({ action: 'list' }, context))
      assert.equal(list.bridges[0].name, 'cold'); assert.equal(list.bridges[0].allocation, 'unallocated')
      assert.equal(JSON.parse(await second.execute({ action: 'start', name: 'missing' }, context)).error.code, 'UNKNOWN_BRIDGE')
      assert.equal(JSON.parse(await second.execute({ action: 'detect', type: 'claude', executable: join(root, 'absent.exe') }, context)).error.code, 'CLI_UNAVAILABLE')
      assert.match(await second.execute({ action: 'start', name: 'cold' }, context), /listening/)
    } finally { await second.close() }
  } finally { await first.close(); rmSync(root, { recursive: true, force: true }) }
})

test('shutdown and abort during start clean listeners and prevent late discovery', async () => {
  for (const mode of ['shutdown', 'abort'] as const) {
    const root = mkdtempSync(join(tmpdir(), 'a2a-race-')); const cwd = join(root, 'work'); mkdirSync(cwd)
    const context = owner(cwd); const controller = new AbortController(); context.signal = controller.signal
    const entered = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>()
    let observedPort = 0
    const config: A2aConfig = { agents: {} }; const tokens = new Map<string, string>()
    const setup = new A2aSetup('project', join(root, 'private'), config, (name, token) => { if (token) tokens.set(name, token); else tokens.delete(name) }, () => {}, { beforeRegister: async port => { observedPort = port; entered.resolve(); await release.promise } })
    try {
      await setup.execute({ action: 'configure', name: 'race', cwd, executable: synthetic(root), backend: { type: 'claude', tools: [] } }, context)
      const starting = setup.execute({ action: 'start', name: 'race' }, context)
      await entered.promise
      const closing = mode === 'shutdown' ? setup.close() : undefined
      if (mode === 'abort') controller.abort()
      release.resolve()
      const result = JSON.parse(await starting)
      assert.equal(result.error.code, mode === 'shutdown' ? 'SETUP_CLOSED' : 'CANCELLED')
      await closing
      assert.deepEqual(config.agents, {}); assert.equal(tokens.size, 0)
      await assert.rejects(fetch(`http://127.0.0.1:${observedPort}/`))
    } finally { release.resolve(); await setup.close(); rmSync(root, { recursive: true, force: true }) }
  }
})

test('unconfigured runtime setup hot-discovers, delegates, continues and restores owned synthetic sessions', async () => {
  const { Hono } = await import('hono')
  const { createA2aRuntime } = await import('./runtime.ts')
  const { readFileSync } = await import('node:fs')
  const { setTimeout } = await import('node:timers/promises')
  const root = mkdtempSync(join(tmpdir(), 'a2a-runtime-')); const cwd = join(root, 'work'); mkdirSync(cwd)
  const context = owner(cwd)
  const notifications: unknown[] = []
  const create = () => createA2aRuntime({ projectId: 'project', workspace: root, app: new Hono(),
    sessions: { getSessionState: () => ({ mode: 'session' }), assertFolderAccess: () => {}, deliver: async (...args: unknown[]) => { notifications.push(args) } } as any,
    bus: {} as any, agentTypes: {} as any })
  let runtime = create()
  const setup = () => runtime.tools.find(tool => tool.name === 'a2a_setup')!
  const wait = async (sessionId: string) => {
    for (let i = 0; i < 100; i++) {
      const result = JSON.parse(await runtime.sessions!.read(sessionId, context))
      if (result.status === 'completed') return result
      assert.ok(!['failed', 'rejected', 'uncertain'].includes(result.status), JSON.stringify(result))
      await setTimeout(20)
    }
    assert.fail('Synthetic task did not finish')
  }
  try {
    assert.deepEqual(runtime.sessions!.agents(context), [])
    assert.match(await setup().execute({ action: 'configure', name: 'fixture', cwd, executable: synthetic(root), backend: { type: 'claude', tools: [] } }, context), /configured-stopped/)
    assert.match(await setup().execute({ action: 'start', name: 'fixture' }, context), /listening/)
    assert.equal(runtime.sessions!.agents(context)[0].name, 'a2a:fixture')
    const first = JSON.parse(await runtime.sessions!.start('a2a:fixture', 'synthetic first', context))
    assert.match(first.sessionId, /^remote:/)
    assert.match(JSON.stringify(await wait(first.sessionId)), /first/)
    const second = JSON.parse(await runtime.sessions!.message(first.sessionId, 'synthetic continuation', context))
    assert.equal(second.sessionId, first.sessionId)
    assert.match(JSON.stringify(await wait(first.sessionId)), /continued/)
    await setup().execute({ action: 'stop', name: 'fixture' }, context)
    assert.deepEqual(runtime.sessions!.agents(context), [])
    await runtime.close()
    runtime = create()
    assert.deepEqual(runtime.sessions!.agents(context), [])
    assert.match(await setup().execute({ action: 'list' }, context), /fixture/)
    assert.match(await setup().execute({ action: 'start', name: 'fixture' }, context), /listening/)
    assert.equal(runtime.sessions!.agents(context)[0].name, 'a2a:fixture')
    assert.equal(JSON.parse(await runtime.sessions!.read(first.sessionId, context)).status, 'completed')
    const third = JSON.parse(await runtime.sessions!.message(first.sessionId, 'after restart', context))
    assert.equal(third.sessionId, first.sessionId)
    await wait(first.sessionId)
    const calls = readFileSync(join(cwd, 'invocations.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    assert.equal(calls.length, 3)
    assert.deepEqual(calls.map(call => call.resumed), [false, true, true])
    assert.equal(new Set(calls.map(call => call.id)).size, 1)
  } finally { await runtime.close(); rmSync(root, { recursive: true, force: true }) }
})

test('shutdown attempts every bridge even when one close fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'a2a-close-'))
  const config: A2aConfig = { agents: {} }
  const setup = new A2aSetup('project', join(root, 'private'), config, () => {}, () => {})
  const closed: string[] = []
  // Fault injection at the owned-resource boundary; no real process or credential.
  const running = (setup as unknown as { running: Map<string, { close(): Promise<void> }> }).running
  running.set('bad', { close: async () => { closed.push('bad'); throw new Error('synthetic close failure') } })
  running.set('good', { close: async () => { closed.push('good') } })
  try {
    await assert.rejects(setup.close(), AggregateError)
    assert.deepEqual(closed.sort(), ['bad', 'good'])
    assert.equal(JSON.parse(await setup.execute({ action: 'list' }, owner(root))).error.code, 'SETUP_CLOSED')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
