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

test('active subscribers share reads in one app; scope, visibility, auth and unmount release ownership', { timeout: 5000 }, async t => {
 const { createRenderer, defineComponent, h, nextTick, reactive } = await import('vue')
 const { useServiceGroups } = await import('./service-groups.ts')
 const { createResourceStores, requireResourcePinia } = await import('./stores/app.ts')
 const { useLiveTransportStore } = await import('./stores/live.ts')
 const document = Object.assign(new EventTarget(), { visibilityState: 'visible' })
 const oldDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
 Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
 t.after(() => { if (oldDocument) Object.defineProperty(globalThis, 'document', oldDocument); else Reflect.deleteProperty(globalThis, 'document') })
 const observers = new Set<import('./live-client.ts').LiveObserver>()
 const pool = {
   client: () => ({ subscribe: (_: unknown, observer: import('./live-client.ts').LiveObserver) => {
     observers.add(observer); return { close: () => observers.delete(observer), ready: async () => {} }
   } }),
   observeHost: (_: string, observer: (status: any) => void) => { observer({ phase: 'live' }); return () => {} },
 }
 const requests: { resolve: (value: Response) => void; signal: AbortSignal; url: string }[] = []
 t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => new Promise<Response>(resolve => { requests.push({ resolve, signal: init.signal!, url: String(url) }) }))
 const renderer = createRenderer<any, any>({ patchProp() {}, insert() {}, remove() {}, createElement: () => ({}), createText: () => ({}), createComment: () => ({}), setText() {}, setElementText() {}, parentNode: () => null, nextSibling: () => null })
 const options = reactive({ apiBase: 'http://fixture/projects/shared', projectId: 'shared', active: true, group: '' })
 const values: ReturnType<typeof useServiceGroups>[] = []
 const shown = reactive([true, true])
 const Child = defineComponent({ setup() { values.push(useServiceGroups(() => options)); return () => h('div') } })
 const app = renderer.createApp(defineComponent({ setup() {
   useLiveTransportStore(requireResourcePinia()).pool = pool as any
   return () => h('div', shown.map((show, i) => show ? h(Child, { key: i }) : null))
 } })).use(createResourceStores())
 app.mount({}); t.after(() => app.unmount())
 const waitFor = async (check: () => boolean) => { for (let i=0;i<100 && !check();i++) await new Promise(resolve => setTimeout(resolve, 5)); assert(check()) }
 await waitFor(() => requests.length === 1)
 assert.equal(observers.size, 1)
 requests[0].resolve(Response.json({ revision: 'r1', groups: [], agents: ['agent'] }))
 await waitFor(() => values[0].revision.value === 'r1')
 assert.equal(values[1].revision.value, 'r1')
 shown[0] = false; await nextTick(); assert.equal(observers.size, 1)
 const refresh = values[1].refresh(); await waitFor(() => requests.length === 2)
 await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(requests.length, 2)
 requests[1].resolve(new Response('', { status: 503 })); await refresh
 assert.match(values[1].error.value, /unavailable/i); assert.equal(values[1].revision.value, 'r1')
 const recovered = values[1].refresh(); await waitFor(() => requests.length === 3)
 requests[2].resolve(Response.json({ revision: 'r2', groups: [], agents: [] })); await recovered
 assert.equal(values[1].error.value, ''); assert.equal(values[1].revision.value, 'r2')
 document.visibilityState = 'hidden'; document.dispatchEvent(new Event('visibilitychange')); await nextTick()
 assert.equal(observers.size, 0); await values[1].refresh(); assert.equal(requests.length, 3)
 document.visibilityState = 'visible'; document.dispatchEvent(new Event('visibilitychange'))
 await waitFor(() => requests.length === 4)
 options.group = 'different'; await nextTick(); assert.equal(requests[3].signal.aborted, true)
 await waitFor(() => requests.length === 5); assert.match(requests[4].url, /group=different/)
 requests[3].resolve(Response.json({ revision: 'stale', groups: [], agents: [] }))
 requests[4].resolve(Response.json({ revision: 'new', groups: [], agents: [] }))
 await waitFor(() => values[1].revision.value === 'new')
 const denied = values[1].refresh(); await waitFor(() => requests.length === 6)
 requests[5].resolve(new Response('', { status: 403 })); await denied
 assert.equal(values[1].revision.value, ''); assert.match(values[1].error.value, /unavailable/i)
 options.active = false; await nextTick(); assert.equal(observers.size, 0)
 options.active = true; await waitFor(() => requests.length === 7)
 app.unmount(); assert.equal(requests[6].signal.aborted, true); assert.equal(observers.size, 0)
 requests[6].resolve(Response.json({ revision: 'late', groups: [], agents: [] }))
 await nextTick(); assert.notEqual(values[1].revision.value, 'late')
})
