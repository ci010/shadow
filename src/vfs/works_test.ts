import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InitiativeStore } from '../initiatives/store.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { createWorkTools } from '../tools/work-operations.ts'
import { WORK_TOOL_NAMES } from '../tools/work-names.ts'
import { requireToolText } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { createWorksHandler } from './works.ts'
import { VirtualFs } from './virtual-fs.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'

test('Work VFS and dynamic operations share bounded discovery and existing authority', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home, { isSessionKnown: id => ['owner', 'worker'].includes(id) })
  const alignment = new WorkAlignment(store, { state: id => ['owner', 'worker'].includes(id) ? { sessionId: id, segmentIndex: 0, mode: 'session' } : undefined,
    evidence: async () => {}, changed: async () => {} })
  const base = new Tools(home), tools = new SessionTools(base, home)
  const importer = new ImportTool(new Map(), home)
  const ops = createWorkTools(alignment)
  for (const tool of ops) importer.registerBuiltin(tool.name, tool)
  base.register(new InvokeTool(importer))
  const context: ExecutionContext = { sessionId: 'owner', physicalSessionId: 'owner.0', messageId: 'fixture', senderId: 'fixture', channel: 'web', chatId: 'fixture', signal: new AbortController().signal, tools }
  const invoke = async (name: string, args: Record<string, unknown>, ctx = context) => requireToolText(await base.get('invoke_tool')!.execute({ name, args }, ctx))
  const handler = createWorksHandler(alignment), vfs = new VirtualFs()
  vfs.mount('v:works', 'Work index and notes', handler.read, handler.list)
  const read = new ReadTool(home, vfs), search = new SearchTool(home, undefined, vfs)
  base.register(read); base.register(search)
  try {
    assert.deepEqual(ops.map(tool => tool.name), WORK_TOOL_NAMES)
    assert.equal(base.get('work'), undefined)
    assert.equal(tools.getDefinitions().some(def => def.function.name === 'work'), false)
    for (const name of WORK_TOOL_NAMES) {
      const metadata = JSON.parse(await importer.readVirtual(name, context))
      assert.equal(metadata.name, name)
      assert.equal(metadata.parameters.additionalProperties, false)
      assert.equal(metadata.parameters.properties.action, undefined)
      assert.equal(metadata.parameters.properties.data, undefined)
    }
    const data = { title: 'Root', definition: { objective: 'Synthetic goal' }, notes: { kind: 'goal' }, idempotencyKey: 'fixture' }
    const created = JSON.parse(await invoke('work_create', data))
    assert.deepEqual(JSON.parse(await invoke('work_create', data)), created)
    assert.equal(created.version, 1)
    assert.equal(created.definition, undefined)
    const child = JSON.parse(await invoke('work_create', { title: 'Child', assignee: null, parentKey: created.key, definition: { objective: 'Collect evidence' }, notes: { relation: { kind: 'supports', reason: 'Supports the root outcome' } } }))
    const childView = JSON.parse(await handler.read(`keys/${encodeURIComponent(child.key)}/path`, context))
    assert.deepEqual(childView.path.map((node: {key: string}) => node.key), [created.key, child.key])
    const path = `keys/${encodeURIComponent(created.key)}`
    const full = JSON.parse(await handler.read(path, context))
    assert.equal(full.records[0].definition.objective, 'Synthetic goal')
    assert.equal(full.records[0].path[0].key, created.key)
    for (const hidden of ['creationRequest', 'botSource', 'automaticExecution', 'proposals', 'transition', 'adoptions']) assert.equal(full.records[0][hidden], undefined)
    assert.equal(JSON.parse(await handler.read(`${path}/notes`, context)).notes.kind, 'goal')
    assert.match(await invoke('work_update', { key: created.key, version: 1, data: {} }), /invalid arguments/)
    assert.match(await invoke('work_create', { ...data, definition: { objective: 'x', evidence: [{ opaque: true }] } }), /invalid arguments/)
    assert.match(await invoke('work_update', { key: created.key, version: 1, notes: { basis: [] } }), /invalid arguments/)
    const updated = JSON.parse(await invoke('work_update', { key: created.key, version: 1, notes: { summary: 'Measured' } }))
    assert.equal(updated.version, 2)
    const attention = JSON.parse(await invoke('work_update', { key: created.key, version: 2, notes: { attention: { kind: 'scope', summary: 'Inspect impact' } } }))
    assert.equal(attention.impactPending, true)
    assert.match(await invoke('work_review', { key: created.key, version: 3, conclusion: 'Not your branch' }, { ...context, sessionId: 'worker' }), /coordinator|control/)
    const reviewed = JSON.parse(await invoke('work_review', { key: created.key, version: 3, conclusion: 'Scope remains valid' }))
    assert.equal(reviewed.version, 4)
    assert.equal(reviewed.impactPending, false)
    assert.match(await invoke('work_update', { key: created.key, version: 1, status: 'done' }), /changed/)
    assert.match(await invoke('work_update', { key: created.key, version: 4, notes: { summary: 'Unauthorized' } }, { ...context, sessionId: 'worker' }), /assigned branch/)
    const assigned = JSON.parse(await invoke('work_assign', { key: created.key, version: 4, assignee: 'worker' }))
    assert.equal(assigned.assignee, 'worker')
    assert.equal(JSON.parse(await invoke('work_link', { key: created.key }, { ...context, sessionId: 'worker' })).key, created.key)
    for (let i = 0; i < 20; i++) await invoke('work_create', { title: `Receipt ${i}`, assignee: null, definition: { objective: `Goal ${i}` } })
    const first = JSON.parse(await handler.read('index', context))
    assert.equal(first.items.length, 20)
    assert.equal(first.next, 'v:works/index/2')
    assert.equal(JSON.parse(await handler.read('index/2', context)).items.length, 2)
    const associations = JSON.parse(await handler.read('context', context))
    const remaining = JSON.parse(await handler.read('context/2', context))
    assert.equal(associations.items.length, 20)
    assert.equal(associations.next, 'v:works/context/2')
    assert.equal(remaining.items.length, 2)
    assert.equal(remaining.next, null)
    assert.equal(new Set([...associations.items, ...remaining.items].map(item => item.key)).size, 22)
    const exactText = await handler.read(path, context)
    const exact = JSON.parse(exactText)
    assert.equal(exact.associated, undefined)
    assert.equal(exact.associatedPath, 'v:works/context')
    assert.equal(exact.records.length, 1)
    assert.equal(exact.records[0].key, created.key)
    for (const item of [...associations.items, ...remaining.items]) {
      if (item.key !== created.key && item.key !== exact.selected) assert(!exactText.includes(item.key), 'Exact reads must not expand unrelated associations')
    }
    const broadEntries = await handler.list(context)
    const keyEntries = broadEntries.filter(entry => entry.name.startsWith('keys/'))
    assert.equal(keyEntries.length, 20)
    for (const entry of keyEntries) {
      const detail = JSON.parse(entry.content)
      assert.equal(detail.associated, undefined, 'Broad grep must not repeat the unpaginated inventory per key')
      assert.equal(detail.records.length, 1)
      assert.equal(detail.associatedPath, 'v:works/context')
    }
    const associationSearch = await search.execute({ handler: 'grep', query: '"associated"\\s*:', path: 'v:works' }, context)
    assert.doesNotMatch(associationSearch, /"associated"\s*:/)
    assert.match(requireToolText(await read.execute({ path: 'v:works/index' }, context)), /v:works\/index\/2/)
    assert.match(await search.execute({ handler: 'glob', query: '**', path: 'v:works' }, context), /keys\//)
    assert.match(await search.execute({ handler: 'glob', query: '**', path: 'v:works', limit: 1, offset: 1 }, context), /v:works\//)
    assert.match(await search.execute({ handler: 'grep', query: 'Receipt', path: 'v:works/index/2' }, context), /Receipt/)
    assert.match(await search.execute({ handler: 'grep', query: 'Measured', path: `v:works/${path}` }, context), /Measured/)
    assert((await handler.list(context)).some(entry => entry.warning))
    await assert.rejects(async () => handler.read(path, { ...context, sessionId: 'other-project-session' }), /Project/)
    for (const mode of ['task', 'call'] as const) {
      const scoped = new SessionTools(base, home); scoped.setExecutionScope(mode, [])
      assert.match(await invoke('work_create', data, { ...context, tools: scoped }), /not available|unavailable|not active/)
      await assert.rejects(async () => handler.read(path, { ...context, tools: scoped }), /unavailable/)
    }
    const restricted = new SessionTools(base, home, ['read', 'search'])
    assert.match(await invoke('work_create', data, { ...context, tools: restricted }), /not available|not active/)
    await assert.rejects(async () => handler.read(path, { ...context, tools: restricted }), /unavailable/)
    const allowed = new SessionTools(base, home, ['work'])
    assert(allowed.has('invoke_tool'))
    assert(allowed.canUseDynamic('work_update'))
    assert(!allowed.canUseDynamic('arbitrary_dynamic'))
    const blocked = new SessionTools(base, home, undefined, ['work'])
    assert(!blocked.canUseDynamic('work_update'))
    assert(importer.canInvokeFromRemote('work_update'))
  } finally { await tools.resetDynamicAndWait(); store.close() }
}))
