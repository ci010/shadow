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
changed: async () => {} })
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
    const data = { title: 'Root', definition: 'Synthetic goal', kind: 'goal', idempotencyKey: 'fixture' }
    const created = JSON.parse(await invoke('work_create', data))
    assert.deepEqual(JSON.parse(await invoke('work_create', { ...data, dependencies: [] })), created)
    assert.equal(created.version, 1)
    assert.equal(created.definition, undefined)
    const child = JSON.parse(await invoke('work_create', { title: 'Child', assignee: null, parentKey: created.key, definition: 'Collect evidence' }))
    const childView = JSON.parse(await handler.read(`keys/${encodeURIComponent(child.key)}/path`, context))
    assert.deepEqual(childView.path.map((node: {key: string}) => node.key), [created.key, child.key])
    const path = `keys/${encodeURIComponent(created.key)}`
    const full = JSON.parse(await handler.read(path, context))
    assert.equal(full.records[0].definition, 'Synthetic goal')
    assert.equal(full.records[0].path[0].key, created.key)
    for (const hidden of ['creationRequest', 'botSource', 'automaticExecution', 'proposals', 'transition', 'adoptions']) assert.equal(full.records[0][hidden], undefined)
    assert.equal(full.records[0].kind, 'goal')
    assert.equal(JSON.parse(await handler.read(`${path}/summary`, context)).summary, '')
    assert.match(await invoke('work_update', { key: created.key, version: 1, data: {} }), /invalid arguments/)
    assert.match(await invoke('work_create', { ...data, definition: { objective: 'x', evidence: [{ opaque: true }] } }), /invalid arguments/)
    assert.match(await invoke('work_update', { key: created.key, version: 1, basis: [] }), /invalid arguments/)
    const updated = JSON.parse(await invoke('work_update', { key: created.key, version: 1, summary: 'Measured' }))
    assert.equal(updated.version, 2)
    assert.equal(JSON.parse(await handler.read(`${path}/summary`, context)).summary, 'Measured')
    assert.match(await invoke('work_update', { key: created.key, version: 2, attention: { kind: 'scope', summary: 'Retired' } }), /invalid arguments/)
    assert.match(await invoke('work_review', { key: created.key, version: 2, conclusion: 'Bad intent', disposition: 'approve' }), /invalid arguments/)
    assert.match(await invoke('work_review', { key: created.key, version: 2, conclusion: 'Nothing stale' }), /no stale ancestor/)
    assert.match(await invoke('work_update', { key: created.key, version: 1, status: 'done' }), /changed/)
    assert.match(await invoke('work_update', { key: created.key, version: 2, summary: 'Unauthorized' }, { ...context, sessionId: 'worker' }), /assigned branch/)
    const assigned = JSON.parse(await invoke('work_assign', { key: created.key, version: 2, assignee: 'worker' }))
    assert.equal(assigned.assignee, 'worker')
    const worker = { ...context, sessionId: 'worker' }
    assert.match(await invoke('work_note_create', { workKey: created.key, body: 'Forged', target: 'owner' }, worker), /invalid arguments/)
    const saved = JSON.parse(await invoke('work_note_create', { workKey: created.key, body: 'Exact **comment**', notifyManager: true }, worker))
    assert.equal(saved.notification, 'queued')
    const exactNote = `${path}/comments/id/${saved.note.id}`
    assert.deepEqual(JSON.parse(await handler.read(exactNote, context)), saved.note)
    assert.equal(JSON.parse(await handler.read(path, context)).commentsPath, `v:works/${path}/comments`)
    assert.deepEqual(JSON.parse(await handler.read(`${path}/comments`, context)), { items: [{ ...saved.note, path: `v:works/${exactNote}` }], next: null })
    assert.deepEqual((await handler.list(context, { subpath: exactNote, content: false })).map(item => item.name), [exactNote])
    assert.match(await search.execute({ handler: 'grep', query: 'Exact', path: `v:works/${path}/comments` }, context), /Exact/)
    assert.doesNotMatch(await search.execute({ handler: 'grep', query: 'Exact', path: 'v:works' }, context), /Exact.*comment/)
    await assert.rejects(async () => handler.read(`${path}/comments/before/not-a-cursor`, context), /UUID|uuid/)
    for (let i = 0; i < 10; i++) await invoke('work_note_create', { workKey: created.key, body: `Follow-up ${i}` }, worker)
    const comments = JSON.parse(await handler.read(`${path}/comments`, context))
    assert.equal(comments.items.length, 10)
    assert.equal(JSON.parse(await handler.read(comments.next.slice('v:works/'.length), context)).items[0].id, saved.note.id)
    const reply = JSON.parse(await invoke('work_note_create', { workKey: created.key, body: 'Manager response', replyTo: saved.note.id }))
    assert.equal(reply.notification, 'queued')
    assert.equal(reply.note.replyTo, saved.note.id)
    assert.deepEqual(store.pendingWorkNotifications('worker').map(n => n.kind), ['note_reply'])
    assert.equal(JSON.parse(await invoke('work_link', { key: created.key }, { ...context, sessionId: 'worker' })).key, created.key)
    const dependent = JSON.parse(await invoke('work_create', { title: 'Dependent', definition: 'Use collected evidence', assignee: null, dependencies: [child.key] }))
    assert.deepEqual(store.workRecords().find(record => record.key === dependent.key)?.dependencies, [child.key])
    assert.equal(dependent.version, 1)
    for (let i = 0; i < 19; i++) await invoke('work_create', { title: `Receipt ${i}`, assignee: null, definition: `Goal ${i}` })
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
      assert.match(await invoke('work_note_create', { workKey: created.key, body: 'Denied' }, { ...context, tools: scoped }), /not available|unavailable|not active/)
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
