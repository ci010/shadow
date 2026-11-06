import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises'
import { EventProviderTool } from '../../tools/event-provider.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { CapabilityBroker, validateJsonSchema } from '../../execution/grants.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { githubDefinition } from './github.ts'
import { EventProviderRuntime } from './runtime.ts'
import { assertReadQuery } from './contracts.ts'
import type { SessionInput } from '../../sessions/input.ts'

const processor = 'export function run({event}) { return [{content:event.data.title},{content:"second"}] }'
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
    const make = () => new EventProviderRuntime(workspace, broker, async (id, input) => {
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
    let status = runtime.discover('owner')
    assert.equal(status.pending.length, 2)
    assert.deepEqual(status.pending.map(j => j.stage).sort(), ['delivery', 'processor'])
    const stableId = status.pending.find(j => j.subscription === 'a')!.id
    await runtime.stop()
    runtime = make(); runtime.start(); rejectDelivery = false; now += 60001
    await runtime.run()
    assert.equal(accepted.length, 2)
    assert.equal(new Set(accepted.map(i => i.id)).size, 2)
    status = runtime.discover('owner'); assert.deepEqual(status.pending.map(j => j.subscription), ['bad'])
    assert.ok(stableId)
    const stored = await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8')
    assert.doesNotMatch(stored, /synthetic-only/)
    await runtime.stop()
  })
})

test('separate repository connections batch; pagination incomplete or GraphQL partial errors never advance snapshot', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let mode = 'partial'; let requests = 0; const variables: Array<Record<string, unknown>> = []
    const runtime = new EventProviderRuntime(workspace, { execute: async (grant, raw) => {
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
    let saved = JSON.parse(await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8'))
    assert.deepEqual(saved.demands, {})
    mode = 'stuck'; now += 60001; await runtime.run()
    saved = JSON.parse(await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8')); assert.deepEqual(saved.demands, {})
    mode = 'good'; now += 60001; await runtime.run()
    saved = JSON.parse(await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8'))
    assert.equal(Object.keys(saved.demands).length, 2); assert.equal(saved.jobs.length, 0, 'successful first complete baseline remains silent after failed collections')
    assert.equal(variables.at(-1)?.use1, false, 'completed connection excluded on later pages')
    assert.equal(variables.at(-1)?.c0, 'next')
    await runtime.stop()
  })
})

test('custom provider immutable revision and query policy', async () => {
  for (const query of ['mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}', 'query($x:String){viewer{login}} mutation { x }', '{viewer{login}}', 'query($x:String){viewer{login}} # comment']) assert.throws(() => assertReadQuery(query))
  await withTempWorkspace(async workspace => {
    const runtime = new EventProviderRuntime(workspace, { execute: async () => { throw new Error('no transport needed') } }, async () => { throw new Error('no delivery') }, () => true, () => true)
    runtime.start()
    const definition = { id: 'custom', version: 1, description: 'fixture extension', queries: ['query Fixture($id:ID!){node(id:$id){id}}'], code: 'export function run({demands}) { const result={}; for(const d of demands) result[d.key]={events:[],checkpoint:null}; return result; }' }
    runtime.publish('owner', definition)
    assert.throws(() => runtime.publish('owner', definition), /Immutable/)
    runtime.publish('owner', { ...definition, version: 2 })
    runtime.create('owner', { id: 'custom-instance', provider: 'custom', version: 2, secretRef: 'pat', origin: 'https://graphql.example.com' })
    assert.equal(runtime.discover('owner').instances[0].origin, 'https://graphql.example.com')
    assert.throws(() => runtime.create('owner', { id: 'wrong-origin', provider: 'github-issues', version: 1, secretRef: 'pat', origin: 'https://graphql.example.com' }), /requires api.github.com/)
    runtime.subscribe('owner', { id: 'custom-sub', instance: 'custom-instance', demand: { id: 'node' }, processor: 'export function run(){return []}' })
    await runtime.run()
    assert.equal(runtime.discover('owner').pending.length, 0)
    assert.equal(runtime.discover('owner').providers.length, 3)
    await runtime.stop()
  })
})

test('broker read-only GraphQL policy enforced without mutation receipts, before credential resolution/transport', async () => {
  await withTempWorkspace(async workspace => {
    let requests = 0; let secrets = 0
    const query = 'query Fixture($id:ID!){node(id:$id){id}}'
    const broker = new CapabilityBroker({ projectId: 'fixture', directory: join(workspace, 'receipts'),
      resolveSecret: async () => { secrets++; return 'synthetic-only' }, deliver: async () => undefined, canDeliver: () => false,
      request: async () => { requests++; return new Response('{"data":{}}', { status: 200 }) } })
    const grant = { id: 'fetch', kind: 'http' as const, origin: 'https://api.github.com', routes: [{ method: 'POST' as const, path: '/graphql' }],
      credential: { secretRef: 'pat', header: 'Authorization', prefix: 'Bearer ' }, readOnlyGraphqlQueries: [query] }
    const context = { sessionId: 'owner', inputId: 'fixture', toolCallId: 'fixture', bindingKey: 'fixture', revision: 'v1', signal: new AbortController().signal, assertCurrent: () => {} }
    for (const body of [{ query: 'mutation($id:ID!){deleteIssue(input:{issueId:$id}){clientMutationId}}', variables: {} }, { query, variables: {}, extensions: {} }]) await assert.rejects(broker.execute(grant, { method: 'POST', path: '/graphql', body }, context))
    await assert.rejects(broker.execute({ ...grant, readOnlyGraphqlQueries: ['mutation($x:ID!){deleteIssue(input:{issueId:$x}){clientMutationId}}'] }, { method: 'POST', path: '/graphql', body: { query, variables: {} } }, context))
    assert.equal(requests, 0); assert.equal(secrets, 0)
    for (let i=0;i<2;i++) await broker.execute(grant, { method: 'POST', path: '/graphql', body: { query, variables: { id: String(i) } } }, context)
    assert.equal(requests, 2, 'read queries refresh data, not cached mutation results')
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
    const runtime = new EventProviderRuntime(workspace, { execute: async (_grant, _raw, context) => {
      requests++; staleCheck = context.assertCurrent; entered()
      return new Promise((_resolve, reject) => { context.signal.addEventListener('abort', () => { aborted++; reject(new Error('aborted fixture network')) }, { once: true }) })
    } }, async () => { throw new Error('must not deliver') }, () => true, () => true)
    runtime.start()
    runtime.create('owner', { id: 'watch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'sub', instance: 'watch', demand: { repository: 'test/repo' }, processor })
    const running = runtime.run(); await waiting
    const candidate = { id: 'github-issues', description: 'edited builtin extension', stateVersion: 'snapshot-v1', queries: githubDefinition.queries,
      code: 'export function run({demands}){ const r={}; for(const d of demands) r[d.key]={events:[],checkpoint:null}; return r; }' }
    await runtime.reload('owner', candidate); await running
    assert.equal(aborted, 1); assert.equal(intervals, 1, 'reload reuses the one host scheduler')
    assert.throws(() => staleCheck!(), /abort|Stale/i)
    assert.equal(runtime.discover('owner').instances[0].version, 2)
    let saved = JSON.parse(await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8'))
    assert.deepEqual(saved.demands, {}, 'cancelled generation cannot commit baseline/cursor')
    await assert.rejects(runtime.reload('owner', { ...candidate, code: 'export function run( broken' }))
    assert.equal(runtime.discover('owner').instances[0].version, 2, 'invalid reload restores coherent old revision')
    assert.throws(() => staleCheck!(), /abort|Stale/i, 'failed reload never reauthorizes old capabilities')
    assert.throws(() => runtime.reload('owner', { ...candidate, stateVersion: 'incompatible' }), /incompatible/)
    now += 60001; await runtime.run()
    saved = JSON.parse(await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8'))
    assert.equal(Object.keys(saved.demands).length, 1, 'old valid revision remains usable after failed reload')
    assert.equal(requests, 1, 'old builtin code was not scheduled again')
    // Reload a network-using revision, then stop during an active request.
    await runtime.reload('owner', { ...candidate, code: `import {call} from '@shadow/fetch'; export async function run({demands,queries}) { if(!demands.length)return {}; await call({query:queries[0],variables:{id:'fixture'}}); return {}; }` })
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
    const runtime = new EventProviderRuntime(workspace, { execute: async () => ({ status: 200, body: { data: { r0: { issues: { nodes: [issue(revision)], pageInfo: { hasNextPage: false } } } } } }) },
      async (id, input) => { deliveries++; return { status: 'accepted', sessionId: id, inputId: input.id } }, () => true, () => true)
    runtime.start(); runtime.create('owner', { id: 'watch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'spin', instance: 'watch', demand: { repository: 'test/repo' }, processor: 'export function run(){while(true){} }' })
    await runtime.run(); revision = 'v2'; now += 60001
    const running = runtime.run()
    // Wait for collection to atomically persist its job, not for the hanging processor to finish.
    for (let attempt=0;attempt<100;attempt++) {
      const state = JSON.parse(await readFile(projectStoragePath(workspace, '.events', 'providers-v1.json'), 'utf8'))
      if(state.jobs.length) break
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    await runtime.reload('owner', { id: 'github-issues', description: 'edited', queries: githubDefinition.queries, code: 'export function run({demands}) { const r={};for(const d of demands)r[d.key]={events:[],checkpoint:null};return r; }' })
    await running
    const pending = runtime.discover('owner').pending
    assert.equal(pending.length, 1); assert.equal(pending[0].stage, 'processor'); assert.equal(pending[0].attempts, 0)
    assert.equal(deliveries, 0)
    await runtime.stop()
  })
})

test('agent edit+reload from local files needs no direct-user code gate; permissions and filesystem scope remain enforced', async () => {
  await withTempWorkspace(async workspace => {
    const cwd = join(workspace, 'authoring'); await mkdir(cwd)
    const manifest = { id: 'authored', description: 'fixture', code_file: 'provider.ts', queries: ['query Fixture($id:ID!){node(id:$id){id}}'] }
    await writeFile(join(cwd, 'manifest.json'), JSON.stringify(manifest))
    await writeFile(join(cwd, 'provider.ts'), 'export function run({demands}){const r={};for(const d of demands)r[d.key]={events:[],checkpoint:null};return r}')
    const runtime = new EventProviderRuntime(workspace, { execute: async () => { throw new Error('no external IO authorized') } }, async () => { throw new Error('no delivery') }, id => id === 'owner', () => true)
    runtime.start(); const tool = new EventProviderTool(runtime, 'fixture')
    const context = { sessionId: 'owner', projectId: 'fixture', inputSource: 'event', cwd, signal: new AbortController().signal } as ExecutionContext
    await tool.execute({ action: 'reload', path: 'manifest.json' }, context)
    assert.equal(runtime.discover('owner').providers.at(-1)?.version, 1)
    await writeFile(join(cwd, 'provider.ts'), 'export function run({demands}){const r={};for(const d of demands)r[d.key]={events:[],checkpoint:{revision:2}};return r}')
    await tool.execute({ action: 'reload', path: 'manifest.json' }, context)
    assert.equal(runtime.discover('owner').providers.at(-1)?.version, 2)
    await assert.rejects(tool.execute({ action: 'create', input_json: JSON.stringify({ id: 'x', provider: 'authored', version: 2, secretRef: 'pat' }) }, context), /direct user/)
    await assert.rejects(tool.execute({ action: 'reload', path: 'manifest.json' }, { ...context, projectId: 'other' }), /Wrong Project/)
    await writeFile(join(workspace, 'outside.ts'), 'export function run(){return {}}')
    await symlink(join(workspace, 'outside.ts'), join(cwd, 'escape.ts'))
    await writeFile(join(cwd, 'manifest.json'), JSON.stringify({ ...manifest, code_file: 'escape.ts' }))
    await assert.rejects(tool.execute({ action: 'reload', path: 'manifest.json' }, context), /inside local cwd/)
    assert.equal(runtime.discover('owner').providers.at(-1)?.version, 2)
    await runtime.stop()
  })
})

test('reload drains in-flight inbox acceptance and reconciles host receipt without duplicate delivery', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let revision = 'v1'; let deliveries = 0
    let entered!: () => void; const entering = new Promise<void>(resolve => { entered = resolve })
    let release!: () => void; const released = new Promise<void>(resolve => { release = resolve })
    const runtime = new EventProviderRuntime(workspace, { execute: async () => ({ status: 200, body: { data: { r0: { issues: { nodes: [issue(revision)], pageInfo: { hasNextPage: false } } } } } }) },
      async (id, input) => { deliveries++; entered(); await released; return { status: 'accepted', sessionId: id, inputId: input.id } }, () => true, () => true)
    runtime.start(); runtime.create('owner', { id: 'watch', provider: 'github-issues', version: 1, secretRef: 'pat' })
    runtime.subscribe('owner', { id: 'sub', instance: 'watch', demand: { repository: 'test/repo' }, processor: 'export function run(){return [{content:"fixture"}]}' })
    await runtime.run(); revision = 'v2'; now += 60001
    const running = runtime.run(); await entering
    let swapped = false
    const reload = runtime.reload('owner', { id: 'github-issues', description: 'edited', queries: githubDefinition.queries, code: 'export function run({demands}) { const r={};for(const d of demands)r[d.key]={events:[],checkpoint:null};return r; }' }).then(() => { swapped = true })
    await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(swapped, false, 'reload must drain already-started delivery')
    release(); await Promise.all([running, reload])
    assert.equal(runtime.discover('owner').pending.length, 1, 'accepted receipt retained until cleanup cycle')
    await runtime.run()
    assert.equal(deliveries, 1); assert.equal(runtime.discover('owner').pending.length, 0)
    await runtime.stop()
  })
})

test('three sessions share one authorized batch with private transforms; revoke drops pending and in-flight fanout', async t => {
  await withTempWorkspace(async workspace => {
    let now = Date.now(); t.mock.method(Date, 'now', () => now)
    let revision = 'v1'; let calls = 0; let reject = false; let credential = true
    let duringCollection: (() => void) | undefined
    const deliveries: Array<{ session: string; content: string }> = []
    const runtime: EventProviderRuntime = new EventProviderRuntime(workspace, { execute: async (_grant, raw) => {
      calls++
      const variables = (raw.body as { variables: Record<string, unknown> }).variables
      assert.equal(variables.use0, true); assert.equal(variables.use1, runtime.discover('c').subscriptions.length > 0); assert.equal(variables.use2, false)
      duringCollection?.(); duringCollection = undefined
      return { status: 200, body: { data: Object.fromEntries([0, 1].filter(n => variables[`use${n}`]).map(n => [`r${n}`, { issues: { nodes: [{ ...issue(revision), id: `I_${n}` }], pageInfo: { hasNextPage: false, endCursor: null } } }])) } }
    } }, async (session, input) => {
      if (reject) throw new Error('inbox unavailable')
      deliveries.push({ session, content: input.kind === 'message' ? String(input.content) : '' })
      return { status: 'accepted', sessionId: session, inputId: input.id }
    }, id => ['owner', 'b', 'c', 'stranger'].includes(id), () => credential)
    runtime.start()
    runtime.create('owner', { id: 'shared', provider: 'github-issues', version: 1, secretRef: 'pat', allowedSubscribers: ['b', 'c'] })
    for (const [owner, repository] of [['owner', 'test/repo'], ['b', 'Test/Repo'], ['c', 'other/repo']]) {
      runtime.subscribe(owner, { id: owner, instance: 'shared', demand: { repository }, processor: `export function run({event}) { return [{content:${JSON.stringify(owner)} + ':' + event.data.title}] }` })
    }
    assert.throws(() => runtime.subscribe('stranger', { id: 'x', instance: 'shared', demand: { repository: 'test/repo' }, processor }), /not authorized/)
    assert.throws(() => runtime.pause('b', 'shared', false), /not owned/)
    assert.throws(() => runtime.share('b', { id: 'shared', allowedSubscribers: [] }), /not owned/)
    assert.throws(() => runtime.share('owner', { id: 'shared', allowedSubscribers: ['remote'] }), /durable local/)
    const visible = runtime.discover('b')
    assert.equal(visible.instances.length, 0); assert.equal(visible.sharedInstances.length, 1)
    assert.doesNotMatch(JSON.stringify(visible), /secretRef|allowedSubscribers|processor.*owner:/)
    await runtime.run(); assert.equal(calls, 1); assert.equal(deliveries.length, 0)
    revision = 'v2'; now += 60001
    await runtime.run(); assert.equal(calls, 2)
    assert.deepEqual(deliveries.map(d => [d.session, d.content]).sort(), [['b', 'b:fixture'], ['c', 'c:fixture'], ['owner', 'owner:fixture']])
    reject = true; revision = 'v3'; now += 60001; await runtime.run()
    assert.equal(runtime.discover('b').pending.length, 1)
    runtime.share('owner', { id: 'shared', allowedSubscribers: ['c'] })
    assert.equal(runtime.discover('b').pending.length, 0)
    runtime.unsubscribe('c', 'c'); assert.equal(runtime.discover('c').pending.length, 0)
    reject = false; now += 60001; await runtime.run()
    assert.equal(deliveries.filter(d => d.session !== 'owner').length, 2)
    runtime.share('owner', { id: 'shared', allowedSubscribers: ['b'] })
    revision = 'v4'; now += 60001
    duringCollection = () => runtime.share('owner', { id: 'shared', allowedSubscribers: [] })
    await runtime.run()
    assert.equal(deliveries.filter(d => d.session === 'b').length, 1, 'revoked during collection cannot receive fanout')
    reject = true; revision = 'v5'; now += 60001; await runtime.run()
    assert.equal(runtime.discover('owner').pending.length, 1)
    credential = false; reject = false; now += 60001; await runtime.run()
    assert.equal(runtime.discover('owner').pending.length, 0, 'credential revocation discards pending delivery')
    await runtime.stop()
  })
})
