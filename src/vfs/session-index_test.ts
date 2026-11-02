import assert from 'node:assert/strict'
import test from 'node:test'
import type { TopicService } from '../sessions/topics.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { ReadTool } from '../tools/read.ts'
import { SearchTool } from '../tools/search.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { requireToolText } from '../tools/tool.ts'
import { createSessionsHandler } from './mounts.ts'
import { VirtualFs } from './virtual-fs.ts'

function fixture() {
  const state = (sessionId: string, extra: Partial<SessionState> = {}): SessionState => ({ sessionId, segmentIndex: 0, config: {}, ...extra })
  const states = [
    state('web:old', { name: 'Old conversation', lastActivityAt: '2026-01-01' }),
    state('web:root', { name: 'Provider names', description: 'Default names\nfor providers', lastActivityAt: '2026-02-01' }),
    state('virtual:child', { name: 'Implementation', description: 'Child purpose', parent: { id: 'web:root' }, mode: 'task', executionStatus: 'completed' }),
    state('virtual:review', { parent: { id: 'virtual:child' }, mode: 'call', executionStatus: 'failed' }),
    state('virtual:orphan', { parent: { id: 'web:gone' }, mode: 'task' }),
    state('cron:legacy'), state('heartbeat:legacy'), state('work-observer:legacy'),
    state('web:automation', { automation: { jobId: 'job' } as SessionState['automation'] }),
    state('web:peer', { name: 'Independent peer', createdBySessionId: 'web:root' }),
  ]
  let historyReads = 0
  const handler = createSessionsHandler({
    listSessions: () => [],
    listHistorySessions: async () => states,
    getSessionState: () => null,
    readSessionState: async id => states.find(state => state.sessionId === id) ?? null,
    getHistory: async () => { historyReads++; return { messages: [{ role: 'user' as const, content: 'history needle' }], total: 1 } },
  }, () => ({
    assertActor: () => {},
    summaries: async () => states.filter(state => state.sessionId.startsWith('web:')).map(state => ({ sessionId: state.sessionId, title: state.name ?? '', description: state.description ?? '' })),
  }) as unknown as TopicService)
  const vfs = new VirtualFs()
  vfs.mount('v:sessions', 'Sessions', handler.read, handler.list, undefined, handler.directory)
  const context = { tools: new SessionTools(new Tools('.'), '.'), signal: new AbortController().signal } as unknown as ExecutionContext
  return { states, handler, context, read: new ReadTool('.', vfs), search: new SearchTool('.', undefined, vfs), historyReads: () => historyReads }
}

test('session navigation defaults to titled root conversations without reading histories', async () => {
  const f = fixture()
  const root = await f.handler.read('', f.context)
  assert.match(root, /Conversations \(3\)/)
  assert.match(root, /- title: Provider names\n  id: web:root\n  description: Default names for providers/)
  assert.doesNotMatch(root, /mode=session/)
  assert.match(root, /children: 1 → v:sessions\/web:root\/children/)
  assert.match(root, /web:peer/)
  assert.doesNotMatch(root, /virtual:child|cron:legacy|heartbeat:legacy|work-observer:legacy|web:automation/)
  assert.ok(root.indexOf('id: web:root') < root.indexOf('id: web:old'))
  assert.equal(f.historyReads(), 0)
})

test('all, tasks and direct children are readable and pageable through ReadTool', async () => {
  const f = fixture()
  const read = async (path: string) => requireToolText(await f.read.execute({ path }, f.context))
  const children = await read('v:sessions/web:root/children')
  assert.match(children, /Children of web:root \(1\)/)
  assert.match(children, /title: Implementation/)
  assert.match(children, /status=completed.*parent=web:root/)
  assert.match(children, /v:sessions\/virtual:child\/children/)
  assert.doesNotMatch(children, /virtual:review/)
  assert.match(await read('v:sessions/virtual:child/children'), /virtual:review/)
  assert.match(await read('v:sessions/web:old/children'), /\(0\):\n\(none\)/)
  await assert.rejects(read('v:sessions/web:missing/children'), /Unknown parent/)
  const tasks = await read('v:sessions/tasks')
  assert.match(tasks, /Tasks \/ internal sessions \(7\)/)
  assert.match(tasks, /virtual:orphan/)
  assert.doesNotMatch(tasks, /id: web:root/)
  const all = await read('v:sessions/all')
  assert.match(all, /All sessions \(10\)/)
  assert.match(all, /title: \(not set\)\n  id: [^\n]+\n  description: \(not set\)/)
  const page = requireToolText(await f.read.execute({ path: 'v:sessions/all', offset: 2, limit: 1 }, f.context))
  assert.ok(page.startsWith(all.split('\n')[1]))
  assert.equal(f.historyReads(), 0)
})

test('global search remains exhaustive, metadata searchable and child hits retain parent context', async () => {
  const f = fixture()
  const glob = await f.search.execute({ handler: 'glob', path: 'v:sessions', query: '**' }, f.context)
  assert.match(glob, /virtual:review/)
  assert.match(glob, /heartbeat:legacy/)
  assert.doesNotMatch(glob, /\/all|\/tasks|\/children/)
  assert.equal(f.historyReads(), 0)
  const hit = await f.search.execute({ handler: 'grep', path: 'v:sessions', query: 'Child purpose' }, f.context)
  assert.match(hit, /v:sessions\/virtual:child/)
  const line = Number(hit.match(/Line (\d+):/)?.[1])
  const page = requireToolText(await f.read.execute({ path: 'v:sessions/virtual:child', offset: line, limit: 1 }, f.context))
  assert.match(page, /^description: Child purpose/)
  const history = await f.handler.read('virtual:child', f.context)
  assert.match(history, /parent=web:root/)
  assert.match(history, /children: v:sessions\/virtual:child\/children/)
})

test('index previews are bounded, empty views navigable and cancellation preserved', async () => {
  const f = fixture()
  f.states[1].description = 'x'.repeat(500)
  assert.match(await f.handler.read('', f.context), new RegExp(`description: ${'x'.repeat(239)}…`))
  f.states.splice(0)
  assert.match(await f.handler.read('', f.context), /Conversations \(0\).*\nViews:/)
  await assert.rejects(async () => f.handler.read('', { ...f.context, signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('metadata search avoids brief duplicates without losing full descriptions or brief discovery', async () => {
  const f = fixture()
  f.states[1].description = 'x'.repeat(300) + ' unique-tail'
  const hit = await f.search.execute({ handler: 'grep', path: 'v:sessions', query: 'Provider names|unique-tail' }, f.context)
  assert.match(hit, /title: Provider names/)
  assert.match(hit, /unique-tail/)
  assert.doesNotMatch(hit, /\/brief/)
  const glob = await f.search.execute({ handler: 'glob', path: 'v:sessions', query: '**/brief' }, f.context)
  assert.match(glob, /v:sessions\/web:root\/brief/)
  const brief = await f.search.execute({ handler: 'grep', path: 'v:sessions/web:root/brief', query: 'unique-tail' }, f.context)
  assert.match(brief, /unique-tail/)
  const direct = requireToolText(await f.read.execute({ path: 'v:sessions/web:root/brief' }, f.context))
  assert.equal(JSON.parse(direct).description, f.states[1].description)
})

test('list-mode pages complete session items in every navigation view, not text blocks', async () => {
  const f = fixture()
  const read = async (path: string, offset = 1, limit = 2) => requireToolText(await f.read.execute({ path, flag: 'l', offset, limit }, f.context))
  const first = await read('v:sessions')
  assert.match(first, /items 1–2 of 3/)
  assert.match(first, /id: web:root/)
  assert.match(first, /id: web:old/)
  assert.doesNotMatch(first, /id: web:peer/)
  assert.match(first, /children: 1 → v:sessions\/web:root\/children/)
  assert.match(first, /use offset=3/)
  const second = await read('v:sessions', 3)
  assert.match(second, /items 3–3 of 3/)
  assert.match(second, /id: web:peer/)
  assert.doesNotMatch(second, /id: web:root|more item/)
  for (const [path, total] of [['v:sessions/all', 10], ['v:sessions/tasks', 7], ['v:sessions/web:root/children', 1]] as const) {
    const page = await read(path, 1, 1)
    assert.match(page, new RegExp(`items 1–1 of ${total}`))
    assert.equal(page.match(/^  id:/gm)?.length, 1)
  }
  assert.match(await read('v:sessions', 100), /items 0 of 3.*\n\(none\)/)
  assert.match(await read('v:sessions/web:old/children'), /items 0 of 0/)
  assert.equal(f.historyReads(), 0)
  const text = requireToolText(await f.read.execute({ path: 'v:sessions', offset: 1, limit: 2 }, f.context))
  assert.doesNotMatch(text, /id: web:root/)
  for (const offset of [0, -1, 1.5]) await assert.rejects(read('v:sessions', offset), /positive safe integer/)
  await assert.rejects(read('v:sessions/web:missing/children'), /Unknown parent/)
  await assert.rejects(f.read.execute({ path: 'v:sessions', flag: 'l' }, { ...f.context, signal: AbortSignal.abort() }), { name: 'AbortError' })
})

test('owned cached remote conversations count as separate items only when discoverable', async () => {
  let discoverable = true
  const handler = createSessionsHandler({ listSessions: () => [], getSessionState: () => null,
    getHistory: async () => ({ messages: [], total: 0 }) }, undefined, {
    canDiscover: () => discoverable,
    entries: () => [{ name: 'remote:one', content: 'first remote' }, { name: 'remote:two', content: 'second remote' },
      { name: 'remote:one/executions/task', content: 'not a conversation' }],
    read: async () => '',
  })
  const f = fixture()
  const directory = await handler.directory('', f.context)
  assert.equal(directory?.items.length, 2)
  assert.match(directory!.items[0], /first remote/)
  assert.match(directory!.items[1], /second remote/)
  discoverable = false
  assert.equal((await handler.directory('', f.context))?.items.length, 0)
  assert.equal(await handler.directory('remote:one', f.context), null)
})
