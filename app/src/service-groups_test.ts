import test from 'node:test'
import assert from 'node:assert/strict'
import { projectGroupConversations, observedGroupId, observedGroupKey, groupDisplayName, type ServiceGroup } from './service-groups.ts'
import type { SidebarSession } from './folders-sidebar.ts'
const group: ServiceGroup = { botInstanceId: 'qq-service', platform: 'qq', conversationId: 'group:00112233445566778899', botName: 'QQ', enabled: false, pending: true, lastSeen: 1, messages: [] }
const session: SidebarSession = { sessionId: 'historical-id', projectId: 'p', channelAddress: { projectId: 'p', botInstanceId: group.botInstanceId, platform: 'qq', conversationId: group.conversationId }, label: 'old', isDirectChat: false, isCurrent: false, parentSessionId: null, depth: 0 }
test('observed groups project into the existing Bot conversation tree without creating executable sessions', () => {
 const rows = projectGroupConversations([], [group, group], 'p')
 assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, observedGroupId(group)); assert.equal(observedGroupKey(rows[0].sessionId), JSON.stringify([group.botInstanceId, group.conversationId]))
 assert.equal(rows[0].isDirectChat, false); assert.equal(rows[0].groupObservation?.pending, true)
 assert.equal(groupDisplayName(group), 'QQ group · 778899'); assert(!rows[0].label.includes('group:'))
})
test('existing QQ history keeps its exact ID and is deduplicated by full scoped Bot address', () => {
 const rows = projectGroupConversations([session], [group], 'p')
 assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, 'historical-id'); assert.equal(session.label, 'old')
 assert.equal(rows[0].groupObservation, group)
})
test('canonical legacy IDs match without creating a parallel row', () => {
 const legacy = { ...session, sessionId: 'qq:group:old', channelAddress: undefined }
 const rows = projectGroupConversations([legacy], [{ ...group, sessionId: legacy.sessionId }], 'p')
 assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, legacy.sessionId); assert.equal(rows[0].channelAddress?.botInstanceId, group.botInstanceId)
})
test('cross Project and cross Bot addresses cannot steal existing sessions', () => {
 assert.equal(projectGroupConversations([{ ...session, projectId: 'other' }], [group], 'p')[0].sessionId, observedGroupId(group))
 const other = { ...session, channelAddress: { ...session.channelAddress!, projectId: 'other' } }
 assert.equal(projectGroupConversations([other], [group], 'p').length, 1)
 assert.equal(projectGroupConversations([session], [{ ...group, botInstanceId: 'another' }], 'p').length, 2)
})

test('active subscribers share polling, concurrent refresh and recover after errors; final unmount aborts', async t => {
 const { createRenderer, defineComponent, h, nextTick, reactive } = await import('vue')
 const { useServiceGroups } = await import('./service-groups.ts')
 const intervals = new Set<() => void>()
 t.mock.method(globalThis, 'setInterval', (callback: () => void) => { intervals.add(callback); return callback })
 t.mock.method(globalThis, 'clearInterval', (callback: () => void) => { intervals.delete(callback) })
 const requests: { resolve: (value: Response) => void; signal: AbortSignal; url: string }[] = []
 t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => new Promise<Response>(resolve => { requests.push({ resolve, signal: init.signal!, url: String(url) }) }))
 const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
 const options = reactive({ apiBase: 'http://fixture/projects/shared', projectId: 'shared', active: true, group: '' })
 const values: ReturnType<typeof useServiceGroups>[] = []
 const mount = () => { const app = renderer.createApp(defineComponent({ setup() { values.push(useServiceGroups(() => options)); return () => h('div') } })); app.mount({}); return app }
 const a = mount(), b = mount()
 t.after(() => { a.unmount(); b.unmount() })
 assert.equal(intervals.size, 1); assert.equal(requests.length, 1)
 const p = values[0].refresh(); assert.equal(values[1].refresh(), p)
 requests[0].resolve(Response.json({ revision: 'r1', groups: [], agents: ['agent'] })); await p; await nextTick()
 assert.equal(values[0].revision.value, 'r1'); assert.equal(values[1].revision.value, 'r1')
 a.unmount(); assert.equal(intervals.size, 1)
 const failed = values[1].refresh(); requests[1].resolve(new Response('', { status: 503 })); await failed
 assert.equal(values[1].error.value, 'unavailable'); assert.equal(values[1].revision.value, 'r1')
 const recovered = values[1].refresh(); requests[2].resolve(Response.json({ revision: 'r2', groups: [], agents: [] })); await recovered
 assert.equal(values[1].error.value, ''); assert.equal(values[1].revision.value, 'r2')
 options.group = 'different'; await nextTick()
 assert.equal(requests.length, 4); assert.match(requests[3].url, /group=different/)
 assert.equal(values[1].revision.value, '')
 options.active = false; await nextTick()
 assert.equal(intervals.size, 0); assert.equal(requests[3].signal.aborted, true)
 options.active = true; await nextTick()
 assert.equal(intervals.size, 1); assert.equal(requests.length, 5)
 b.unmount(); assert.equal(intervals.size, 0); assert.equal(requests[4].signal.aborted, true)
 requests[4].resolve(Response.json({ revision: 'late', groups: [], agents: [] }))
 requests[3].resolve(Response.json({ revision: 'stale', groups: [], agents: [] })); await Promise.resolve(); await nextTick()
 assert.notEqual(values[1].revision.value, 'stale')
})
