import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { EventProviderRuntime } from './runtime.ts'
import { CapabilityBroker, CapabilityError } from '../../execution/grants.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import type { ProviderBrowserAccess } from '../../browser/provider-fetch.ts'

const transport = { kind: 'browser' as const, instance: '0ad04ff9-9b91-4b9f-8830-3ddba8ca35ff', targetId: 'target-a' }
const definition = { id: 'feed', version: 1, description: 'fixture', http: { origin: 'https://api.example.org', routes: [{ method: 'GET' as const, path: '/feed', querySchema: { type: 'object', additionalProperties: false } }] },
  code: `import {call} from '@shadow/fetch'; export async function run({demands}) { const result = {}; for(const d of demands) { const r = await call({method:'GET',path:'/feed'}); result[d.key] = {events:[{id:'one',data:r.body}],checkpoint:null}; } return result; }` }
const { version: _version, ...reloadDefinition } = definition
const subscription = { id: 'watch', instance: 'feed-watch', demand: {}, processor: 'export function run(){return []}' }

async function setup(workspace: string, browser: ProviderBrowserAccess, authored: unknown = definition) {
  let native = 0
  const broker = new CapabilityBroker({ projectId: 'fixture', directory: join(workspace, 'receipts'), resolveSecret: async () => 'secret', deliver: async () => undefined, canDeliver: () => false,
    request: async () => { native++; throw new Error('must not fall back') } })
  const runtime = new EventProviderRuntime(workspace, broker, async () => { throw new Error('unexpected') }, owner => owner === 'owner', () => true)
  runtime.start(); runtime.publish('owner', authored)
  runtime.create('owner', { id: 'feed-watch', provider: 'feed', version: 1, transport }, browser)
  runtime.subscribe('owner', subscription)
  return { runtime, native: () => native, broker }
}

test('browser transport stays instance-bound across reload, permissions and restart; never falls back to native', async t => withTempWorkspace(async workspace => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  let allowed = true, requests = 0
  const access: ProviderBrowserAccess = { binding: transport, assertCurrent: () => { if (!allowed) throw new Error('revoked') }, request: async (url, init) => {
    requests++; assert.equal(String(url), 'https://api.example.org/feed'); assert.equal(init?.credentials, 'include'); assert.equal(init?.method, 'GET')
    assert.equal((init?.headers as any).authorization, undefined)
    return new Response('{"title":"fixture"}')
  } }
  const { runtime, broker, native } = await setup(workspace, access)
  t.after(() => runtime.stop())
  await runtime.run(); assert.equal(requests, 1)
  assert.equal(runtime.discover('owner').instances[0].transport.kind, 'browser')
  assert.throws(() => runtime.reload('owner', { ...reloadDefinition, http: { ...definition.http, routes: [{ method: 'GET', path: '/other' }] } }), /expansion/)
  assert.throws(() => runtime.reload('owner', { ...reloadDefinition, transport: { kind: 'native' } }), /Unrecognized/)
  await runtime.reload('owner', reloadDefinition)
  assert.deepEqual(runtime.discover('owner').instances[0].transport, transport)
  assert.throws(() => runtime.bindBrowser('stranger', 'feed-watch', access), /durable/)
  assert.throws(() => runtime.bindBrowser('owner', 'feed-watch', { ...access, binding: { ...transport, targetId: 'other' } }), /mismatch/)
  allowed = false; now += 60001; await runtime.run()
  assert.equal(requests, 1); assert.equal(runtime.discover('owner').errors['feed-watch'], 'browser_context_unavailable')
  await runtime.stop(); allowed = true
  const restarted = new EventProviderRuntime(workspace, broker, async () => { throw new Error('unexpected') }, id => id === 'owner', () => true)
  restarted.start(); t.after(() => restarted.stop()); now += 60001; await restarted.run()
  assert.equal(restarted.discover('owner').errors['feed-watch'], 'browser_context_unavailable'); assert.equal(native(), 0)
  restarted.bindBrowser('owner', 'feed-watch', access); now += 60001; await restarted.run(); assert.equal(requests, 2)
}))

test('browser requires explicit authorization and disallows secret/native/builtin combinations', async t => withTempWorkspace(async workspace => {
  const access: ProviderBrowserAccess = { binding: transport, assertCurrent() {}, request: async () => new Response('{}') }
  const { runtime } = await setup(workspace, access); t.after(() => runtime.stop())
  const create = (extra: object, browser?: ProviderBrowserAccess) => runtime.create('owner', { id: 'other', provider: 'feed', version: 1, transport, ...extra }, browser)
  assert.throws(() => create({}), /authorized browser context/)
  assert.throws(() => create({ secretRef: 'pat' }, access), /cookie-only/)
  assert.throws(() => create({ provider: 'github-issues', secretRef: 'pat' }, access), /cookie-only/)
  assert.throws(() => create({ transport: { kind: 'native' } }, access), /cannot bind/)
  runtime.create('owner', { id: 'native-default', provider: 'feed', version: 1 })
  assert.deepEqual(runtime.discover('owner').instances.find(i => i.id === 'native-default')?.transport, { kind: 'native' })
}))

for (const action of ['stop', 'reload'] as const) test(`${action} drains cancellation of pending browser fetch before returning`, async t => withTempWorkspace(async workspace => {
  const started = Promise.withResolvers<void>(); const release = Promise.withResolvers<void>(); let drained = false
  const access: ProviderBrowserAccess = { binding: transport, assertCurrent() {}, request: async (_url, init) => {
    started.resolve()
    await new Promise<void>(resolve => init!.signal!.addEventListener('abort', () => resolve(), { once: true }))
    await release.promise; drained = true; throw new Error('aborted fixture')
  } }
  const { runtime } = await setup(workspace, access); t.after(() => runtime.stop())
  const cycle = runtime.run(); await started.promise
  let finished = false
  const operation = (action === 'stop' ? runtime.stop() : runtime.reload('owner', reloadDefinition)).then(() => { finished = true })
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(finished, false)
  release.resolve(); await operation; await cycle
  assert.equal(drained, true)
}))

test('broker validates method, canonical route, query/body and credential policy before browser IO', async () => withTempWorkspace(async workspace => {
  let calls = 0
  const broker = new CapabilityBroker({ projectId: 'fixture', directory: join(workspace, 'receipts'), resolveSecret: async () => { throw new Error('must not resolve') }, deliver: async () => undefined, canDeliver: () => false })
  const grant = { id: 'fetch', kind: 'http' as const, ...definition.http }
  const context = { sessionId: 'owner', inputId: crypto.randomUUID(), toolCallId: 't', bindingKey: 'b', revision: 'r', signal: new AbortController().signal, assertCurrent() {},
    browserRequest: async () => { calls++; return new Response('plain text') } }
  for (const input of [{ method: 'POST', path: '/feed' }, { method: 'GET', path: '//other.example/feed' }, { method: 'GET', path: '/feed', query: { extra: 'no' } }, { method: 'GET', path: '/feed', body: {} }]) await assert.rejects(broker.execute(grant, input, context))
  await assert.rejects(broker.execute({ ...grant, credential: { secretRef: 'pat', header: 'Authorization', prefix: 'Bearer ' } }, { method: 'GET', path: '/feed' }, context), /cannot be combined/)
  const postGrant = { ...grant, routes: [{ method: 'POST' as const, path: '/feed', bodySchema: { type: 'object', required: ['cursor'], additionalProperties: false, properties: { cursor: { type: 'string' } } } }] }
  await assert.rejects(broker.execute(postGrant, { method: 'POST', path: '/feed', body: { unexpected: true }, idempotencyKey: 'fixture' }, context))
  assert.equal(calls, 0)
  assert.deepEqual(await broker.execute(grant, { method: 'GET', path: '/feed' }, context), { status: 200, body: 'plain text' })
  assert.deepEqual(await broker.execute(postGrant, { method: 'POST', path: '/feed', body: { cursor: 'a' }, idempotencyKey: 'fixture' }, context), { status: 200, body: 'plain text' })
}))


for (const code of ['browser_fetch_failed', 'browser_cleanup_unconfirmed']) test(`host-owned ${code} survives restricted script failure`, async () => withTempWorkspace(async workspace => {
  const access: ProviderBrowserAccess = { binding: transport, assertCurrent() {}, request: async () => { throw new CapabilityError(code, 'sanitized fixture failure') } }
  const { runtime } = await setup(workspace, access)
  await runtime.run()
  assert.equal(runtime.discover('owner').errors['feed-watch'], code)
  if (code === 'browser_cleanup_unconfirmed') {
    await assert.rejects(runtime.reload('owner', reloadDefinition), /sanitized fixture failure/)
    await assert.rejects(runtime.stop(), /sanitized fixture failure/)
  } else await runtime.stop()
}))


test('POST cleanup uncertainty blocks lifecycle while retaining mutation no-replay receipt', async () => withTempWorkspace(async workspace => {
  let requests = 0
  const access: ProviderBrowserAccess = { binding: transport, assertCurrent() {}, request: async () => { requests++; throw new CapabilityError('browser_cleanup_unconfirmed', 'cleanup unconfirmed fixture') } }
  const post = { ...definition, http: { ...definition.http, routes: [{ method: 'POST' as const, path: '/feed' }] },
    code: definition.code.replace("{method:'GET',path:'/feed'}", "{method:'POST',path:'/feed',body:{cursor:'a'},idempotencyKey:'fixed'}") }
  const { runtime, broker } = await setup(workspace, access, post)
  await runtime.run()
  assert.equal(requests, 1)
  assert.equal(runtime.discover('owner').errors['feed-watch'], 'browser_cleanup_unconfirmed')
  const { version: _version, ...reloadPost } = post
  await assert.rejects(runtime.reload('owner', reloadPost), /cleanup unconfirmed/)
  await assert.rejects(runtime.stop(), /cleanup unconfirmed/)
  const grant = { ...post.http, id: 'fetch', kind: 'http' as const }
  const context = { sessionId: 'owner', inputId: crypto.randomUUID(), toolCallId: 'provider:feed-watch', bindingKey: 'provider:feed-watch', revision: 'r', signal: new AbortController().signal, assertCurrent() {}, browserRequest: access.request }
  await assert.rejects(broker.execute(grant, { method: 'POST', path: '/feed', body: { cursor: 'a' }, idempotencyKey: 'fixed' }, context), (error: any) => error.code === 'uncertain_outcome')
  assert.equal(requests, 1)
}))

test('browser HTML string fixture parses locally then subscriber extracts structured event', async t => withTempWorkspace(async workspace => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  let title = 'baseline'; const messages: string[] = []
  const access: ProviderBrowserAccess = { binding: transport, assertCurrent() {}, request: async () =>
    new Response(`<article><h1>${title} &amp; local</h1></article>`, {headers:{'content-type':'text/html'}}) }
  const broker = new CapabilityBroker({ projectId:'fixture', directory:join(workspace,'receipts'),
    resolveSecret:async()=>{throw new Error('no secrets')},deliver:async()=>undefined,canDeliver:()=>false,
    request:async()=>{throw new Error('no native fallback')} })
  const runtime = new EventProviderRuntime(workspace, broker, async (id, input) => {
    if(input.kind === 'message') messages.push(input.content)
    return {status:'accepted',sessionId:id,inputId:input.id}
  }, () => true, () => true)
  runtime.start();t.after(()=>runtime.stop())
  const code = `import {call} from '@shadow/fetch';import {parseHtml} from '@shadow/html';
    export async function run({demands}){const result={};for(const d of demands){
      const r=await call({method:'GET',path:'/feed'});const title=parseHtml(r.body).querySelector('article > h1').textContent;
      result[d.key]={mode:'snapshot',events:[{id:title,data:{title}}],checkpoint:null};}return result}`
  runtime.publish('owner',{...definition,code})
  runtime.create('owner',{id:'feed-watch',provider:'feed',version:1,transport},access)
  runtime.subscribe('owner',{...subscription,processor:`import {parseHtml} from '@shadow/html';
    export function run({event}){return [{content:parseHtml('<p>'+event.data.title+'</p>').querySelector('p').textContent}]}`})
  await runtime.run();assert.deepEqual(messages,[])
  await runtime.reload('owner',{...reloadDefinition,code})
  title='changed';now+=60001;await runtime.run();assert.deepEqual(messages,['changed & local'])
}))
