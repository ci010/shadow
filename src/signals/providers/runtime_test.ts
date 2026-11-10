import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { SignalProviderTool } from '../../tools/signal-provider.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { CapabilityBroker, validateJsonSchema } from '../../execution/grants.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { githubDefinition } from './github.ts'
import { SignalProviderRuntime } from './runtime.ts'
import type { SessionInput } from '../../sessions/input.ts'

const processor = 'export function run({signal}) { return [{content:signal.data.title},{content:"second"}] }'
const issue = (updatedAt: string) => ({ id: 'I_1', updatedAt, title: 'fixture', number: 1, url: 'https://github.com/test/repo/issues/1', state: 'OPEN' })

test('GraphQL aggregate exact demands, silent baseline, persisted independent processor/outbox retries and restart', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let updated = '2026-01-01'; let calls = 0; let rejectDelivery = true
    const accepted: SessionInput[] = []
    const broker = new CapabilityBroker({ projectId: 'fixture', directory: join(workspace, 'receipts'),
      resolveSecret: async ref => { assert.equal(ref, 'pat'); return 'synthetic-only' },
      deliver: async () => undefined, canDeliver: () => false,
      request: async (url, options) => {
        calls++; assert.equal(String(url), 'https://api.github.com/graphql'); assert.equal(options?.method, 'POST')
        assert.equal((options?.headers as Record<string, string>).authorization, 'Bearer synthetic-only')
        const body = JSON.parse(String(options?.body))
        assert.match(body.query, /^query /); assert.equal(body.variables.use0, true); assert.equal(body.variables.use1, false)
        return new Response(JSON.stringify({ data: { r0: { issues: { nodes: [issue(updated)], pageInfo: { hasNextPage: false, endCursor: null } } } } }), { status: 200 })
      } })
    const make = () => new SignalProviderRuntime(workspace, broker, async (id, input) => {
      if (rejectDelivery) throw new Error('inbox unavailable')
      accepted.push(input); return { status: 'accepted', sessionId: id, inputId: input.id }
    }, id => id === 'owner', ref => ref === 'pat')
    let runtime = make(); runtime.start()
    runtime.create('owner', { id: 'issues', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'a', instance: 'issues', demand: { repository: 'Test/Repo' }, processor })
    runtime.subscribe('owner', { id: 'bad', instance: 'issues', demand: { repository: 'test/repo' }, processor: 'export function run(){throw new Error("fixture")}' })
    assert.throws(() => runtime.subscribe('stranger', { id: 'x', instance: 'issues', demand: {}, processor }), /durable/)
    await runtime.run(); assert.equal(calls, 1); assert.equal(accepted.length, 0)
    await runtime.run(); assert.equal(calls, 1, 'persisted rate reservation')
    updated = '2026-01-02'; now += 60001
    await runtime.run(); assert.equal(calls, 2)
    let status = runtime.snapshot('owner')
    assert.equal(status.pending.length, 2)
    assert.deepEqual(status.pending.map(j => j.stage).sort(), ['delivery', 'processor'])
    const stableId = status.pending.find(j => j.subscription === 'a')!.id
    await runtime.stop()
    runtime = make(); runtime.start(); rejectDelivery = false; now += 60001
    await runtime.run()
    assert.equal(accepted.length, 2)
    assert.equal(new Set(accepted.map(i => i.id)).size, 2)
    status = runtime.snapshot('owner'); assert.deepEqual(status.pending.map(j => j.subscription), ['bad'])
    assert.ok(stableId)
    const stored = await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8')
    assert.doesNotMatch(stored, /synthetic-only/)
    await runtime.stop()
  })
})

test('separate repository connections batch; pagination incomplete or GraphQL partial errors never advance snapshot', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let mode = 'partial'; let requests = 0; const variables: Array<Record<string, unknown>> = []
    const runtime = new SignalProviderRuntime(workspace, { execute: async (grant, raw) => {
      requests++
      assert.equal(grant.kind, 'http')
      if (grant.kind !== 'http') throw new Error('bad grant')
      const body = raw.body as { query: string; variables: Record<string, unknown> }
      validateJsonSchema(grant.routes[0].bodySchema!, body)
      assert.throws(() => validateJsonSchema(grant.routes[0].bodySchema!, { ...body, query: 'mutation { deleteIssue }' }))
      variables.push(body.variables)
      if (mode === 'partial') return { status: 200, body: { data: {}, errors: [{ message: 'untrusted' }] } }
      const page = body.variables.c0
      if (mode === 'stuck') return { status: 200, body: { data: { r0: { issues: { nodes: [issue('v1')], pageInfo: { hasNextPage: true, endCursor: 'same' } } }, r1: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } } }
      return { status: 200, body: { data: { ...(body.variables.use0 ? { r0: { issues: { nodes: [page ? { ...issue('v1'), id: 'I_2' } : issue('v1')], pageInfo: { hasNextPage: !page, endCursor: page ? null : 'next' } } } } : {}), ...(body.variables.use1 ? { r1: { issues: { nodes: [], pageInfo: { hasNextPage: false } } } } : {}) } } }
    } }, async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }), () => true, () => true)
    runtime.start(); runtime.create('owner', { id: 'batch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    for (const [id, repository] of [['one', 'a/repo'], ['two', 'b/repo']]) runtime.subscribe('owner', { id, instance: 'batch', demand: { repository }, processor })
    await runtime.run(); assert.equal(requests, 1)
    let saved = JSON.parse(await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8'))
    assert.deepEqual(saved.demands, {})
    mode = 'stuck'; now += 60001; await runtime.run()
    saved = JSON.parse(await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8')); assert.deepEqual(saved.demands, {})
    mode = 'good'; now += 60001; await runtime.run()
    saved = JSON.parse(await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8'))
    assert.equal(Object.keys(saved.demands).length, 2); assert.equal(saved.jobs.length, 0, 'successful first complete baseline remains silent after failed collections')
    assert.equal(variables.at(-1)?.use1, false, 'completed connection excluded on later pages')
    assert.equal(variables.at(-1)?.c0, 'next')
    await runtime.stop()
  })
})

test('custom provider immutable revision and explicit HTTP policy', async () => {
  await withTempWorkspace(async workspace => {
    const runtime = new SignalProviderRuntime(workspace, { execute: async () => { throw new Error('no transport needed') } }, async () => { throw new Error('no delivery') }, () => true, () => true)
    runtime.start()
    const definition = { id: 'custom', version: 1, description: 'fixture extension', http: githubDefinition.http, code: 'export function run({demands}) { const result={}; for(const d of demands) result[d.key]={signals:[],checkpoint:null}; return result; }' }
    assert.throws(() => runtime.publish('owner', { ...definition, queries: ['obsolete contract'] }), /Unrecognized key/)
    runtime.publish('owner', definition)
    assert.throws(() => runtime.publish('owner', definition), /Immutable/)
    runtime.publish('owner', { ...definition, version: 2 })
    runtime.create('owner', { id: 'custom-instance', provider: 'custom', version: 2, secretRef: 'pat', origin: 'https://api.github.com' })
    assert.equal(runtime.snapshot('owner').instances[0].origin, 'https://api.github.com')
    assert.throws(() => runtime.create('owner', { id: 'wrong-origin', provider: 'github-issues', version: 1, secretRef: 'pat', origin: 'https://graphql.example.com' }), /origin must match/)
    runtime.subscribe('owner', { id: 'custom-sub', instance: 'custom-instance', demand: { id: 'node' }, processor: 'export function run(){return []}' })
    await runtime.run()
    assert.equal(runtime.snapshot('owner').pending.length, 0)
    assert.equal(runtime.snapshot('owner').providers.length, 3)
    await runtime.stop()
  })
})

test('GitHub-owned static body constraints enforced by standard broker schemas before credentials; host-bound reads refresh', async () => {
  await withTempWorkspace(async workspace => {
    let requests = 0; let secrets = 0
    const query = githubDefinition.http.routes[0].bodySchema!.properties as {query:{const:string}}
    const queryText = query.query.const
    const broker = new CapabilityBroker({ projectId: 'fixture', directory: join(workspace, 'receipts'),
      resolveSecret: async () => { secrets++; return 'synthetic-only' }, deliver: async () => undefined, canDeliver: () => false,
      request: async () => { requests++; return new Response('{"data":{}}', { status: 200 }) } })
    const grant = { id: 'fetch', kind: 'http' as const, origin: 'https://api.github.com', routes: githubDefinition.http.routes,
      credential: { secretRef: 'pat', header: 'Authorization', prefix: 'Bearer ' } }
    const context = { sessionId: 'owner', inputId: 'fixture', toolCallId: 'fixture', bindingKey: 'fixture', revision: 'v1', signal: new AbortController().signal, assertCurrent: () => {} }
    for (const body of [{ query: 'mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}', variables: {} }, { query: queryText, variables: {}, extensions: {} }]) await assert.rejects(broker.execute(grant, { method: 'POST', path: '/graphql', body }, context))
    await assert.rejects(broker.execute(grant, { method: 'POST', path: '/graphql', body: { query: queryText + ' ', variables: {} } }, context))
    const mutationGrant = { ...grant, routes: [{ method: 'POST' as const, path: '/search' }] }
    await assert.rejects(broker.execute(mutationGrant, { method: 'POST', path: '/search', effect: 'read', body: {} }, context), /Invalid HTTP input/)
    await assert.rejects(broker.execute(mutationGrant, { method: 'POST', path: '/search', body: {} }, context), /idempotencyKey/)
    assert.equal(requests, 0); assert.equal(secrets, 0)
    for (let i=0;i<2;i++) await broker.execute(grant, { method: 'POST', path: '/graphql', body: { query: queryText, variables: { id: String(i) } } }, context)
    assert.equal(requests, 2, 'read queries refresh data, not cached mutation results')
    const searchGrant = { ...mutationGrant, routes: [{ method: 'POST' as const, path: '/search', effect: 'read' as const,
      bodySchema: { type: 'object', required: ['term'], additionalProperties: false, properties: { term: { type: 'string' } } } }] }
    for (let i=0;i<2;i++) await broker.execute(searchGrant, { method: 'POST', path: '/search', body: { term: 'same' } }, context)
    assert.equal(requests, 4, 'protocol-neutral acquisition POSTs refresh identical polls too')
  })
})

test('reload aborts/drains collection, revokes stale generation, preserves old version on failure, and stop clears scheduler', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let intervals = 0; let clears = 0
    const originalSet = globalThis.setInterval; const originalClear = globalThis.clearInterval
    t.mock.method(globalThis, 'setInterval', (...args: Parameters<typeof setInterval>) => { intervals++; return originalSet(...args) })
    t.mock.method(globalThis, 'clearInterval', (...args: Parameters<typeof clearInterval>) => { clears++; return originalClear(...args) })
    let entered!: () => void; let waiting = new Promise<void>(resolve => { entered = resolve })
    let aborted = 0; let staleCheck: (() => void) | undefined; let requests = 0
    const runtime = new SignalProviderRuntime(workspace, { execute: async (_grant, _raw, context) => {
      requests++; staleCheck = context.assertCurrent; entered()
      return new Promise((_resolve, reject) => { context.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted fixture network')) }, { once: true }) })
    } }, async () => { throw new Error('must not deliver') }, () => true, () => true)
    runtime.start()
    runtime.create('owner', { id: 'watch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'sub', instance: 'watch', demand: { repository: 'test/repo' }, processor })
    const running = runtime.run(); await waiting
    const candidate = { id: 'github-issues', description: 'edited builtin extension', stateVersion: 'snapshot-v1', http: githubDefinition.http,
      code: 'export function run({demands}){ const r={}; for(const d of demands) r[d.key]={signals:[],checkpoint:null}; return r; }' }
    await runtime.reload('owner', candidate); await running
    assert.equal(aborted, 1); assert.equal(intervals, 1, 'reload reuses the one host scheduler')
    assert.throws(() => staleCheck!(), /abort|Stale/i)
    assert.equal(runtime.snapshot('owner').instances[0].version, 2)
    let saved = JSON.parse(await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8'))
    assert.deepEqual(saved.demands, {}, 'cancelled generation cannot commit baseline/cursor')
    await assert.rejects(runtime.reload('owner', { ...candidate, code: 'export function run( broken' }))
    assert.equal(runtime.snapshot('owner').instances[0].version, 2, 'invalid reload restores coherent old revision')
    assert.throws(() => staleCheck!(), /abort|Stale/i, 'failed reload never reauthorizes old capabilities')
    assert.throws(() => runtime.reload('owner', { ...candidate, stateVersion: 'incompatible' }), /incompatible/)
    now += 60001; await runtime.run()
    saved = JSON.parse(await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8'))
    assert.equal(Object.keys(saved.demands).length, 1, 'old valid revision remains usable after failed reload')
    assert.equal(requests, 1, 'old builtin code was not scheduled again')
    // Reload a network-using revision, then stop during an active request.
    await runtime.reload('owner', { ...candidate, code: `import {call} from '@shadow/fetch'; export async function run({demands}) { if(!demands.length)return {}; await call({method:'POST',path:'/graphql',body:{query:'fixture',variables:{}}}); return {}; }` })
    waiting = new Promise<void>(resolve => { entered = resolve }); now += 60001
    const stoppingRun = runtime.run(); await waiting; await runtime.stop(); await stoppingRun
    assert.equal(aborted, 2); assert.equal(clears, 1)
    assert.throws(() => staleCheck!(), /abort|Stale/i)
    await assert.rejects(runtime.run(), /stopped/)
  })
})

test('reload cancels restricted child processing without committing stale drafts or delivering', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let revision = 'v1'; let deliveries = 0
    const runtime = new SignalProviderRuntime(workspace, { execute: async () => ({ status: 200, body: { data: { r0: { issues: { nodes: [issue(revision)], pageInfo: { hasNextPage: false } } } } } }) },
      async (id, input) => { deliveries++; return { status: 'accepted', sessionId: id, inputId: input.id } }, () => true, () => true)
    runtime.start(); runtime.create('owner', { id: 'watch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'spin', instance: 'watch', demand: { repository: 'test/repo' }, processor: 'export function run(){while(true){} }' })
    await runtime.run(); revision = 'v2'; now += 60001
    const running = runtime.run()
    // Wait for collection to atomically persist its job, not for the hanging processor to finish.
    for (let attempt=0;attempt<100;attempt++) {
      const state = JSON.parse(await readFile(projectStoragePath(workspace, '.signals', 'providers-v2.json'), 'utf8'))
      if(state.jobs.length) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await runtime.reload('owner', { id: 'github-issues', description: 'edited', http: githubDefinition.http, code: 'export function run({demands}) { const r={};for(const d of demands)r[d.key]={signals:[],checkpoint:null};return r; }' })
    await running
    const pending = runtime.snapshot('owner').pending
    assert.equal(pending.length, 1); assert.equal(pending[0].stage, 'processor'); assert.equal(pending[0].attempts, 0)
    assert.equal(deliveries, 0)
    await runtime.stop()
  })
})

test('agent edit+reload from local files needs no direct-user code gate; permissions and filesystem scope remain enforced', async () => {
  await withTempWorkspace(async workspace => {
    const cwd = join(workspace, 'authoring'); await mkdir(cwd)
    const manifest = { id: 'authored', description: 'fixture', code_file: 'provider.ts', http: githubDefinition.http }
    await writeFile(join(cwd, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(cwd, 'provider.ts'), 'export function run({demands}){const r={};for(const d of demands)r[d.key]={signals:[],checkpoint:null};return r}')
    const runtime = new SignalProviderRuntime(workspace, { execute: async () => { throw new Error('no external IO authorized') } }, async () => { throw new Error('no delivery') }, id => id === 'owner', () => true)
    runtime.start(); const tool = new SignalProviderTool(runtime, 'fixture')
    const context = { sessionId: 'owner', projectId: 'fixture', inputSource: 'event', cwd, signal: new AbortController().signal } as ExecutionContext
    await tool.execute({ action: 'reload', path: 'manifest.json' }, context)
    assert.equal(runtime.snapshot('owner').providers.at(-1)?.version, 1)
    await writeFile(join(cwd, 'provider.ts'), 'export function run({demands}){const r={};for(const d of demands)r[d.key]={signals:[],checkpoint:{revision:2}};return r}')
    await tool.execute({ action: 'reload', path: 'manifest.json' }, context)
    assert.equal(runtime.snapshot('owner').providers.at(-1)?.version, 2)
    await assert.rejects(tool.execute({ action: 'create', input_json: JSON.stringify({ id: 'x', provider: 'authored', version: 2, secretRef: 'pat' }) }, context), /direct user/)
    await assert.rejects(tool.execute({ action: 'reload', path: 'manifest.json' }, { ...context, projectId: 'other' }), /Wrong Project/)
    await writeFile(join(workspace, 'outside.ts'), 'export function run(){return {}}')
    await symlink(join(workspace, 'outside.ts'), join(cwd, 'escape.ts'))
    await writeFile(join(cwd, 'manifest.json'), JSON.stringify({ ...manifest, code_file: 'escape.ts' }))
    await assert.rejects(tool.execute({ action: 'reload', path: 'manifest.json' }, context), /inside local cwd/)
    assert.equal(runtime.snapshot('owner').providers.at(-1)?.version, 2)
    await runtime.stop()
  })
})

test('reload drains in-flight inbox acceptance and reconciles host receipt without duplicate delivery', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let revision = 'v1'; let deliveries = 0
    let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve })
    const runtime = new SignalProviderRuntime(workspace, { execute: async () => ({ status: 200, body: { data: { r0: { issues: { nodes: [issue(revision)], pageInfo: { hasNextPage: false } } } } } }) },
      async (id, input) => { deliveries++; entered(); await released; return { status: 'accepted', sessionId: id, inputId: input.id } }, () => true, () => true)
    runtime.start(); runtime.create('owner', { id: 'watch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'sub', instance: 'watch', demand: { repository: 'test/repo' }, processor: 'export function run(){return [{content:"fixture"}]}' })
    await runtime.run(); revision = 'v2'; now += 60001
    const running = runtime.run(); await entering
    let swapped = false
    const reload = runtime.reload('owner', { id: 'github-issues', description: 'edited', http: githubDefinition.http, code: 'export function run({demands}) { const r={};for(const d of demands)r[d.key]={signals:[],checkpoint:null};return r; }' }).then(() => { swapped = true })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(swapped, false, 'reload must drain already-started delivery')
    release(); await Promise.all([running, reload])
    assert.equal(runtime.snapshot('owner').pending.length, 1, 'accepted receipt retained until cleanup cycle')
    await runtime.run()
    assert.equal(deliveries, 1); assert.equal(runtime.snapshot('owner').pending.length, 0)
    await runtime.stop()
  })
})

test('Project sessions aggregate demands without sharing and survive creator disappearance', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let creatorAvailable = true; let revision = 'v1'; let calls = 0
    const deliveries: Array<{session: string; content: string}> = []
    const runtime = new SignalProviderRuntime(workspace, { execute: async (_grant, raw, context) => {
      calls++; assert.equal(context.sessionId, creatorAvailable ? 'owner' : 'b')
      const variables = (raw.body as {variables: Record<string, unknown>}).variables
      assert.equal(variables.use0, true); assert.equal(variables.use1, false)
      return { status: 200, body: { data: { r0: { issues: { nodes: [issue(revision)], pageInfo: { hasNextPage: false } } } } } }
    } }, async (session, input) => {
      deliveries.push({ session, content: input.kind === 'message' ? String(input.content) : '' })
      return { status: 'accepted', sessionId: session, inputId: input.id }
    }, id => id === 'b' || (id === 'owner' && creatorAvailable), () => true)
    runtime.start()
    runtime.create('owner', { id: 'shared', provider: 'github-issues', version: 1, secretRef: 'pat' })
    for (const owner of ['owner', 'b']) runtime.subscribe(owner, {id: owner, instance: 'shared', demand: {repository: 'test/repo'}, processor: `export function run({signal}){return [{content:${JSON.stringify(owner)}+':'+signal.data.title}]}`})
    assert.throws(() => runtime.subscribe('foreign', {id:'x',instance:'shared',demand:{},processor}), /durable/)
    runtime.pause('b', 'shared', false); runtime.pause('b', 'shared', true)
    await runtime.run(); assert.equal(calls, 1); assert.equal(deliveries.length, 0)
    revision = 'v2'; now += 60001; await runtime.run()
    assert.deepEqual(deliveries.map(d => d.session).sort(), ['b','owner'])
    creatorAvailable = false; revision = 'v3'; now += 60001; await runtime.run()
    assert.equal(calls, 3); assert.equal(deliveries.at(-1)?.session, 'b')
    assert.throws(() => runtime.unsubscribe('b', 'owner'), /not owned/)
    await runtime.stop()
  })
})

test('obsolete persisted instance allowlists are stripped, not interpreted as access gates or user demand fields', async () => {
  await withTempWorkspace(async workspace => {
    const make = () => new SignalProviderRuntime(workspace, { execute: async () => { throw Error('unused') } }, async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }), id => ['a', 'b'].includes(id), () => true)
    let runtime = make(); runtime.start()
    runtime.publish('a', { id: 'public', version: 1, description: 'fixture', http: { origin: 'https://example.org', routes: [{method:'GET',path:'/feed'}] }, code: 'export function run(){return {}}' })
    runtime.create('a', {id:'watch', provider:'public', version:1})
    assert.throws(() => runtime.create('a', {id:'obsolete', provider:'public', version:1, allowedSubscribers:[]}), /Unrecognized/)
    runtime.subscribe('a', {id:'first', instance:'watch', demand:{allowedSubscribers:['user-data']}, processor:'export function run(){return []}'})
    await runtime.stop()
    const path = projectStoragePath(workspace, '.signals', 'providers-v2.json')
    const stored = JSON.parse(await readFile(path, 'utf8'))
    stored.instances[0].allowedSubscribers = []
    await writeFile(path, JSON.stringify(stored))
    runtime = make(); runtime.start()
    runtime.subscribe('b', {id:'second',instance:'watch',demand:{},processor:'export function run(){return []}'})
    assert.equal('allowedSubscribers' in runtime.snapshot('b').instances[0], false)
    assert.deepEqual(runtime.snapshot('b').subscriptions[0].demand, {allowedSubscribers:['user-data']})
    assert.equal('allowedSubscribers' in JSON.parse(await readFile(path, 'utf8')).instances[0], false)
    await runtime.stop()
  })
})

test('GitHub consumer schema and collector reject missing or malformed promised fields', async () => {
  const valid = issue('2026-01-01')
  validateJsonSchema(githubDefinition.signalSchema, valid)
  for (const field of ['id', 'number', 'title', 'url', 'state', 'updatedAt']) {
    const missing: Record<string, unknown> = {...valid}; delete missing[field]
    assert.throws(() => validateJsonSchema(githubDefinition.signalSchema, missing))
  }
  for (const patch of [{number: 0}, {number: 1.5}, {title: null}, {url: 42}, {state: 'MERGED'}, {updatedAt: false}]) {
    const node = {...valid, ...patch}
    assert.throws(() => validateJsonSchema(githubDefinition.signalSchema, node))
    await withTempWorkspace(async workspace => {
      const runtime = new SignalProviderRuntime(workspace, {execute: async () => ({status:200,body:{data:{r0:{issues:{nodes:[node],pageInfo:{hasNextPage:false,endCursor:null}}}}}})},
        async (id, input) => ({status:'accepted',sessionId:id,inputId:input.id}), () => true, () => true)
      runtime.start()
      runtime.create('owner', {id:'invalid',provider:'github-issues',version:1,secretRef:'fixture'})
      runtime.subscribe('owner', {id:'check',instance:'invalid',demand:{repository:'test/repo'},processor})
      await runtime.run()
      assert.equal(runtime.snapshot('owner').errors.invalid, 'collection_failed')
      await runtime.stop()
    })
  }
})
