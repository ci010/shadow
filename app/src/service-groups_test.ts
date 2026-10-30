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

test('active subscribers share live resources, concurrent refresh and recover after errors; final unmount aborts', async t => {
 const { createRenderer, defineComponent, h, nextTick, reactive } = await import('vue')
 const { useServiceGroups } = await import('./service-groups.ts')
 const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
 const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
 Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
 t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document') })
 const intervals = new Set<() => void>()
 t.mock.method(globalThis, 'setInterval', (callback: () => void) => { intervals.add(callback); return callback })
 t.mock.method(globalThis, 'clearInterval', (callback: () => void) => { intervals.delete(callback) })
 const observers = new Set<import('./live-client.ts').LiveObserver>()
 const pool = {
   client: () => ({ isLive: () => true, subscribe: (_topic: unknown, observer: import('./live-client.ts').LiveObserver) => {
     observers.add(observer); return { close: () => observers.delete(observer), ready: async () => {} }
   } }),
   observeHost: (_base: string, observer: (status: { phase: string }) => void) => { observer({ phase: 'live' }); return () => {} },
   dispose() {},
 }
 const requests: { resolve: (value: Response) => void; signal: AbortSignal; url: string }[] = []
 t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => new Promise<Response>(resolve => { requests.push({ resolve, signal: init.signal!, url: String(url) }) }))
 const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
 const options = reactive({ apiBase: 'http://fixture/projects/shared', projectId: 'shared', active: true, group: '' })
 const values: ReturnType<typeof useServiceGroups>[] = []
 const mount = (livePool = pool) => { const app = renderer.createApp(defineComponent({ setup() { values.push(useServiceGroups(() => options)); return () => h('div') } })); app.provide(Symbol.for('shadow.live-client-pool'), livePool); app.mount({}); return app }
 const a = mount(), b = mount()
 await new Promise(resolve => setImmediate(resolve))
 t.after(() => { a.unmount(); b.unmount() })
 assert.equal(intervals.size, 0); assert.equal(requests.length, 1)
 assert.equal(observers.size, 1)
 const p = values[0].refresh(); assert.equal(values[1].refresh(), p)
 requests[0].resolve(Response.json({ revision: 'r1', groups: [], agents: ['agent'] })); await p; await nextTick()
 assert.equal(values[0].revision.value, 'r1'); assert.equal(values[1].revision.value, 'r1')
 a.unmount(); assert.equal(intervals.size, 0)
 const failed = values[1].refresh(); requests[1].resolve(new Response('', { status: 503 })); await failed
 assert.equal(values[1].error.value, 'unavailable'); assert.equal(values[1].revision.value, 'r1')
 const recovered = values[1].refresh()
 for (const observer of observers) observer.event({ type: 'event', topic: { kind: 'resources', projectId: 'shared' }, payload: { event: 'invalidate', resource: 'service-groups' } } as import('./live-client.ts').LiveEvent)
 await new Promise(resolve => setTimeout(resolve, 150))
 assert.equal(requests.length, 3, 'inflight invalidation does not overlap loads')
 requests[2].resolve(Response.json({ revision: 'r2', groups: [], agents: [] })); await new Promise(resolve => setTimeout(resolve, 0))
 assert.equal(requests.length, 4, 'inflight invalidation queues a followup')
 requests[3].resolve(Response.json({ revision: 'r2', groups: [], agents: [] })); await recovered
 assert.equal(values[1].error.value, ''); assert.equal(values[1].revision.value, 'r2')
 document.visibilityState = 'hidden'
 for (const observer of observers) observer.reset('reconnect')
 await new Promise(resolve => setTimeout(resolve, 150))
 await values[1].refresh()
 assert.equal(requests.length, 4, 'hidden resources do not fetch')
 document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
 await new Promise(resolve => setImmediate(resolve))
 assert.equal(requests.length, 5, 'visibility restoration reloads')
 requests[4].resolve(Response.json({ revision: 'visible', groups: [], agents: [] })); await values[1].refresh()
 for (const observer of observers) observer.reconnected?.()
 await new Promise(resolve => setTimeout(resolve, 150))
 assert.equal(requests.length, 6, 'reconnection reloads')
 requests[5].resolve(Response.json({ revision: 'reconnected', groups: [], agents: [] })); await values[1].refresh()
 options.group = 'different'; await nextTick(); await new Promise(resolve => setImmediate(resolve))
 assert.equal(requests.length, 7); assert.match(requests[6].url, /group=different/)
 assert.equal(values[1].revision.value, '')
 options.active = false; await nextTick()
 assert.equal(intervals.size, 0); assert.equal(requests[6].signal.aborted, true)
 options.active = true; await nextTick(); await new Promise(resolve => setImmediate(resolve))
 assert.equal(intervals.size, 0); assert.equal(requests.length, 8)
 b.unmount(); assert.equal(observers.size, 0); assert.equal(intervals.size, 0); assert.equal(requests[7].signal.aborted, true)
 requests[7].resolve(Response.json({ revision: 'late', groups: [], agents: [] }))
 requests[6].resolve(Response.json({ revision: 'stale', groups: [], agents: [] })); await Promise.resolve(); await nextTick()
 assert.notEqual(values[1].revision.value, 'stale')
 const count = requests.length
 const c = mount(), d = mount({ ...pool })
 await new Promise(resolve => setImmediate(resolve))
 assert.equal(requests.length, count + 2, 'identical hosts in separate injected pools never share resources')
 c.unmount(); d.unmount()
 assert.equal(requests[count].signal.aborted, true); assert.equal(requests[count + 1].signal.aborted, true)
 assert.equal(observers.size, 0)
 requests[count].resolve(Response.json({ revision: 'disposed-c', groups: [], agents: [] }))
 requests[count + 1].resolve(Response.json({ revision: 'disposed-d', groups: [], agents: [] }))
})
