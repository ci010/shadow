import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SignalProviderRuntime } from './runtime.ts'
import { createProviderSignalsHandler } from './vfs.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { createEventsHandler } from '../../vfs/mounts.ts'
import { EventService } from '../../events/service.ts'
import { Bus } from '../../bus/bus.ts'
import { ReadTool } from '../../tools/read.ts'
import { SearchTool } from '../../tools/search.ts'
import { SignalProviderTool } from '../../tools/signal-provider.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

const definition = { id: 'public-feed', version: 1, description: 'fixture', http: { origin: 'https://example.org', routes: [{ method: 'GET', path: '/feed' }] },
  demandSchema: { type: 'object' }, signalSchema: { type: 'object' }, examples: [{ demand: {}, signal: { id: 'one', data: {} } }],
  code: `import {call} from '@shadow/fetch'; export async function run({demands}) { const result = {}; for(const d of demands) { await call({method:'GET',path:'/feed'}); result[d.key]={signals:[],checkpoint:null}; } return result }` }

test('real VFS read/list/search/paging exposes generated Project provider files and preserves internal events', async t => withTempWorkspace(async workspace => {
  const runtime = new SignalProviderRuntime(workspace, { execute: async () => { throw Error('REMOTE_ERROR_WITH_TOKEN') } }, async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }), id => ['a', 'b'].includes(id), () => true)
  runtime.start(); t.after(() => runtime.stop())
  runtime.publish('a', definition)
  runtime.create('a', { id: 'watch', provider: definition.id, version: 1, purpose: 'Public change feed for this Project' })
  runtime.subscribe('b', { id: 'reader', instance: 'watch', demand: {}, processor: 'export function run(){return []}' })
  const events = new EventService(workspace, new Bus(), async (id, input) => ({ status: 'accepted', sessionId: id, inputId: input.id }))
  events.registerSource({source:'fixture-source', kind:'custom', description:'Internal fixture source'})
  const old = events.subscribe({sessionId: 'b', event: 'fixture.changed'})
  const internal = createEventsHandler(events)
  const handler = createProviderSignalsHandler(runtime, 'p', internal)
  const vfs = new VirtualFs(); vfs.mount('v:signals', 'signals', handler.read, handler.list, undefined, handler.directory)
  const ctx = { projectId: 'p', sessionId: 'b', inputSource: 'user', cwd: workspace, signal: new AbortController().signal, tools: { executionMode: 'session' } } as ExecutionContext
  const read = new ReadTool(workspace, vfs), search = new SearchTool(workspace, undefined, vfs, false)
  const get = async (path: string) => String(await read.execute({ path: `v:signals/${path}` }, ctx))
  assert.match(await get(''), /providers/)
  assert.ok((await get('')).length < 1200)
  assert.match(await get('providers/public-feed'), /Public change feed for this Project/)
  assert.doesNotMatch(await get('providers/public-feed'), /example.org|secretRef|binding|checkpoint/)
  assert.throws(() => runtime.publish('a', {...definition, version:9, consumer:{summary:'bad',capabilities:'not-an-array',limitations:[],semantics:[]}}))
  await assert.rejects(get('providers/public-feed/revisions/1/source.ts'), /Unknown/)

  assert.match(await get('authoring/providers/public-feed/revisions/1/manifest.json'), /demandSchema|examples/)
  assert.match(await get('authoring/providers/public-feed/revisions/1/source.ts'), /export async function run/)
  assert.match(await get('authoring/providers/github-issues/revisions/1/source.ts'), /query/)
  assert.match(await get('instances/watch/config.json'), /binding|native/)
  assert.match(await get('subscriptions/reader/processor.ts'), /return \[\]/)
  assert.match(await get('subscriptions/reader/config.json'), /"owner": "b"/)
  assert.match(await get('subscriptions/reader/status.json'), /pending/)
  assert.match(String(await read.execute({ path: 'v:signals/authoring/providers/public-feed/revisions/1/manifest.json', offset: 2, limit: 2 }, ctx)), /id|version/)
  const consumer = await get('providers/github-issues')
  assert.match(consumer, /number|updatedAt/)
  assert.doesNotMatch(consumer, /secretRef|ShadowIssueSnapshots|checkpoint|POST|graphql|targetId/)
  assert.doesNotMatch(await get('providers'), /github-issues\//)
  for (const scope of ['v:signals', 'v:signals/providers']) {
    const found = await vfs.list(scope, ctx)
    assert.ok(found!.every(e => !e.path.endsWith('source.ts')))
    assert.doesNotMatch(String(await search.execute({handler:'grep',query:'ShadowIssueSnapshots',path:scope},ctx)), /source.ts|manifest.json/)
  }
  assert.match(String(await search.execute({handler:'grep',query:'ShadowIssueSnapshots',path:'v:signals/authoring'},ctx)), /source.ts|manifest.json/)
  const files = await vfs.list('v:signals/authoring/providers', ctx, { content: false })
  assert.ok(files!.some(f => f.path.endsWith('/source.ts')))
  assert.match(String(await search.execute({ handler: 'glob', query: '**/source.ts', path: 'v:signals/authoring/providers' }, ctx)), /source.ts/)
  assert.match(String(await search.execute({ handler: 'grep', query: 'demandSchema', path: 'v:signals/authoring/providers' }, ctx)), /manifest.json/)
  assert.equal(await vfs.resolve('v:signals/internal/sources', ctx), await internal.read('sources', ctx))
  assert.match(await get('internal/sources'), /fixture-source/)
  assert.match((await vfs.resolve('v:signals/internal/sources', {...ctx, sessionId:'non-provider-session'}))!, /fixture-source/)
  const internalOnly = {...ctx, sessionId:'non-provider-session'}
  const ownInternal = events.subscribe({sessionId:internalOnly.sessionId,event:'internal.only'})
  assert.doesNotMatch(String(await read.execute({path:'v:signals'}, internalOnly)), /internal.only/)
  assert.match(String(await read.execute({path:'v:signals/internal'}, internalOnly)), /internal.only/)
  assert.ok((await vfs.list('v:signals/internal', internalOnly))!.some(e => e.path.endsWith(ownInternal.id)))
  assert.match(String(await search.execute({handler:'grep',query:'internal.only',path:'v:signals/internal'},internalOnly)), /internal.only/)
  assert.ok((await vfs.list(`v:signals/internal/${ownInternal.id}`, internalOnly))!.length)
  await assert.rejects(vfs.resolve('v:signals/providers', internalOnly)!, /durable local/)
  await assert.rejects(get('internal-missing'), /Unknown/)
  await assert.rejects(get('sources'), /Unknown/)
  await assert.rejects(get('legacy'), /Unknown/)
  assert.match(await get(`internal/${old.id}`), /fixture.changed/)
  assert.doesNotMatch(await get(''), /fixture.changed/)
  assert.match(await get('internal'), /fixture.changed/)
  assert.ok((await vfs.list('v:signals/internal', ctx))!.some(e => e.path === `v:signals/internal/${old.id}`))
  await runtime.run()
  assert.match(await get('instances/watch/status.json'), /collection_failed/)
  const {version: _version, ...revision} = definition
  runtime.create('b', {id:'second', provider:definition.id, version:1})
  runtime.publish('a', {...definition, version: 3, signalSchema: {type:'object',properties:{revisionThree:{type:'string'}}}})
  const pinned = await get('providers/public-feed')
  assert.match(pinned, /Contract version 1/)
  assert.match(pinned, /Contract version 3/)
  assert.match(pinned, /revisionThree/)
  const reload = runtime.reload('b', revision)
  assert.match((await vfs.resolve(`v:signals/internal/${old.id}`, ctx))!, /fixture.changed/)
  assert.ok((await vfs.list('v:signals/internal', ctx))!.some(e => e.path.endsWith(old.id)))
  await reload
  assert.ok(runtime.snapshot('a').instances.every(i => i.version === 4))
  await assert.rejects(get('providers/missing'), /Unknown/)
  await assert.rejects(vfs.resolve('v:signals/instances/watch/config.json', { ...ctx, projectId: 'other' })!, /Wrong Project/)
  await assert.rejects(vfs.list('v:signals', { ...ctx, projectId: 'other' })!, /Wrong Project/)
  assert.throws(() => vfs.write('v:signals/instances/watch/config.json', { content: '{}' }, ctx), /read-only/)
  const tool = new SignalProviderTool(runtime, 'p')
  for (const action of ['discover', 'inspect', 'share']) await assert.rejects(tool.execute({ action }, ctx), /Unknown action/)
  await assert.rejects(tool.execute({ action: 'run' }, { ...ctx, projectId: 'other' }), /Wrong Project/)
  // Project access does not confer any managed-browser authority.
  const browserTool = new SignalProviderTool(runtime, 'p', { contexts: async () => { throw Error('Browser authorization denied') }, bind: () => { throw Error('Browser authorization denied') } })
  await assert.rejects(browserTool.execute({ action: 'bind_browser', input_json: JSON.stringify({ id: 'watch', transport: { kind: 'browser', instance: '0ad04ff9-9b91-4b9f-8830-3ddba8ca35ff', targetId: 'target-a' } }) }, ctx), /Browser authorization denied/)
  await events.stop()
  const dump = JSON.stringify(await vfs.list('v:signals', ctx))
  assert.doesNotMatch(dump, /REMOTE_ERROR_WITH_TOKEN|allowedSubscribers/)
}))
