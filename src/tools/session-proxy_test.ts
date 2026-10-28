import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
﻿import assert from 'node:assert/strict'
import test from 'node:test'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { configureSessionProxy, describeSessionProxy, resetSessionProxy, sessionWebFetch } from '../execution/network/session-proxy.ts'
import type { ExecutionContext } from './context.ts'
import { Tools, SessionTools } from './registry.ts'
import { SessionProxyTool } from './session-proxy.ts'
import { FirecrawlSearchTool, WebSearchTool } from './web.ts'
import { ExaSearchTool } from './exa.ts'
import { TavilySearchTool } from './tavily.ts'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'

function context(): ExecutionContext {
  return { signal: new AbortController().signal, channel: 'web', chatId: 'test', senderId: 'test', messageId: 'test',
    sessionId: 'test', physicalSessionId: 'test', tools: new SessionTools(new Tools(process.cwd()), process.cwd()) }
}
const configured = async () => ({ source: 'environment' as const, http: 'http://127.0.0.1:1/', https: 'http://127.0.0.1:1/', bypass: [] })

test('tool validates actions, isolates sessions, follows owner snapshots, resets and expires on sleep', async () => {
  const tool = new SessionProxyTool(), a = context(), b = context()
  assert.match(await tool.execute({ action: 'get' }, a), /application-default/)
  assert.match(await tool.execute({ action: 'set', mode: 'direct' }, a), /"mode":"direct"/)
  assert.equal(describeSessionProxy(b).configuration.mode, 'inherit')
  assert.equal(describeSessionProxy({ ...a, tools: a.tools.snapshot() }).configuration.mode, 'direct')
  assert.match(await tool.execute({ action: 'set', mode: 'proxy', proxyId: 'http://secret@proxy' }, a), /Unknown proxyId/)
  assert.equal(describeSessionProxy(a).configuration.mode, 'direct')
  for (const args of [{ action: 'oops' }, { action: 'set' }, { action: 'get', mode: 'proxy' }, { action: 'set', mode: 'direct', proxyId: 'configured' }, { action: 'reset', extra: true }]) {
    assert.match(await tool.execute(args, a), /^Error:/)
  }
  await a.tools.resetDynamicAndWait()
  assert.equal(describeSessionProxy(a).configuration.mode, 'inherit')
  await tool.execute({ action: 'set', mode: 'direct' }, a)
  assert.match(await tool.execute({ action: 'reset' }, a), /application-default/)
})

test('static config selection never reveals endpoints and unsupported config fails atomically', async () => {
  const c = context()
  await configureSessionProxy(c, 'proxy', 'configured', configured)
  const summary = JSON.stringify(describeSessionProxy(c))
  assert.doesNotMatch(summary, /127\.0\.0\.1/)
  assert.match(summary, /"fallback":false/)
  await assert.rejects(configureSessionProxy(c, 'proxy', 'configured', async () => ({ source: 'windows-auto', bypass: [] })), /PAC/)
  await configureSessionProxy(c, 'proxy', 'configured', async () => ({ ...(await configured()), source: 'macos-static' }))
  assert.equal(describeSessionProxy(c).effective.source, 'macos-static')
  await assert.rejects(configureSessionProxy(c, 'proxy', 'configured', async () => ({ source: 'macos-auto', bypass: [] })), /PAC/)
  await assert.rejects(configureSessionProxy(c, 'proxy', 'configured', async () => ({ source: 'direct', bypass: [] })), /No configured/)
  assert.equal(describeSessionProxy(c).configuration.mode, 'proxy')
  assert.match(await new SessionProxyTool().execute({ action: 'set', mode: 'direct' }, { ...c, remoteWorkdir: {} as never }), /remote workdir/)
  assert.match(await new SearchTool(process.cwd()).execute({ handler: 'web', query: 'test' }, { ...c, remoteWorkdir: {} as never }), /remote network capability/)
})

test('all built-in search providers and URL read use scoped dispatch; plain fetch and other sessions stay unchanged', async t => {
  const calls: RequestInit[] = []
  t.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    calls.push(init ?? {})
    return Response.json({ data: { web: [] }, results: [], web: { results: [] } })
  })
  const c = context()
  await configureSessionProxy(c, 'direct')
  for (const tool of [new FirecrawlSearchTool(), new WebSearchTool('fixture'), new ExaSearchTool('fixture'), new TavilySearchTool('fixture')]) {
    await tool.execute({ query: 'test' }, c)
    assert.ok('dispatcher' in calls.at(-1)!)
  }
  await new ReadTool(process.cwd()).execute({ path: 'https://fixture.invalid/' }, c)
  assert.ok('dispatcher' in calls.at(-1)!)
  await sessionWebFetch('https://fixture.invalid', {}, context())
  assert.ok(!('dispatcher' in calls.at(-1)!))
  await fetch('https://fixture.invalid')
  assert.ok(!('dispatcher' in calls.at(-1)!))
})

test('Firecrawl override disables direct fallback even when reset during the in-flight request', async t => {
  const c = context()
  await configureSessionProxy(c, 'proxy', 'configured', configured)
  t.mock.method(globalThis, 'fetch', async () => {
    resetSessionProxy(c)
    return Response.json({ error: 'Your IP address looks suspicious' }, { status: 403 })
  })
  let fallback = 0
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { fallback++; return true },
    async directFetch() { throw new Error('Must not retry') },
  })
  assert.match(await tool.execute({ query: 'test' }, c), /blocked the request IP/)
  assert.equal(fallback, 0)
})

test('real scoped proxy tunnel, failed proxy without fallback, bypass refusal, and direct request snapshot', async () => {
  const upstream = createServer((_req, res) => res.end('fixture'))
  const proxy = createServer()
  const sockets = new Set<Socket>()
  for (const server of [upstream, proxy]) server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)) })
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening')
  const target = upstream.address(); assert.ok(target && typeof target !== 'string')
  let tunnels = 0
  proxy.on('connect', (_request, socket, head) => {
    tunnels++
    const remote = connect(target.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      socket.pipe(remote).pipe(socket)
    })
    remote.on('error', () => socket.destroy()); socket.on('error', () => remote.destroy()); socket.on('close', () => remote.destroy())
  })
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening')
  const address = proxy.address(); assert.ok(address && typeof address !== 'string')
  const c = context()
  try {
    await configureSessionProxy(c, 'proxy', 'configured', async () => ({ source: 'environment', http: `http://127.0.0.1:${address.port}`, bypass: [] }))
    assert.equal(await (await sessionWebFetch('http://fixture.invalid/', {}, c)).text(), 'fixture')
    assert.equal(tunnels, 1)
    await assert.rejects(sessionWebFetch(`http://127.0.0.1:${target.port}/`, {}, c), /no fallback/)
    await configureSessionProxy(c, 'proxy', 'configured', configured)
    await assert.rejects(sessionWebFetch('http://fixture.invalid/', {}, c), /no fallback/)
    await configureSessionProxy(c, 'direct')
    const pending = sessionWebFetch(`http://127.0.0.1:${target.port}/`, {}, c)
    await configureSessionProxy(c, 'proxy', 'configured', configured)
    assert.equal(await (await pending).text(), 'fixture')
    assert.equal(tunnels, 1)
  } finally {
    for (const socket of sockets) socket.destroy()
    await Promise.all([upstream, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
})


test('uses existing v:tools discovery and lazy invoke registration without adding a base tool', async () => {
  const c = context()
  const importer = new ImportTool(new Map([['session_proxy', new SessionProxyTool()]]), process.cwd())
  assert.equal(c.tools.has('session_proxy'), false)
  const base = new Tools(process.cwd())
  base.register(new ReadTool(process.cwd()))
  base.register(new InvokeTool(importer))
  c.tools = new SessionTools(base, process.cwd())
  const contract = await importer.readVirtual('session_proxy', c)
  assert.match(contract, /session_proxy/)
  const invoke = new InvokeTool(importer)
  assert.match(String(await invoke.execute({ name: 'session_proxy', args: { action: 'set', mode: 'direct' } }, c)), /"mode":"direct"/)
  assert.ok(c.tools.hasDynamic('session_proxy'))
  assert.match(String(await invoke.execute({ name: 'session_proxy', args: { action: 'set', mode: 'invalid' } }, c)), /contract|schema|enum|direct/i)
  assert.equal(describeSessionProxy(c).configuration.mode, 'direct')
  await c.tools.resetDynamicAndWait()
})

test('explicit fetch propagates cancellation and keeps credentials out of transport errors', async t => {
  const c = context(), abort = new AbortController()
  await configureSessionProxy(c, 'direct')
  t.mock.method(globalThis, 'fetch', async () => {
    abort.abort()
    throw new Error('proxy-user:private-secret@private-host')
  })
  await assert.rejects(sessionWebFetch('https://fixture.invalid', { signal: abort.signal }, c), { name: 'AbortError' })
  await assert.rejects(sessionWebFetch('https://fixture.invalid', {}, c), error => {
    assert.doesNotMatch(String(error), /private-secret|private-host/)
    assert.match(String(error), /no fallback/)
    return true
  })
})
