import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createLiveRefresh } from './live-refresh.ts'
import type { LiveObserver } from './live-client.ts'
import { sessionActivity } from './session-activity.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const root = 'web:chat-parent'
const task = 'web:chat-mode-task'
const graph = () => ({ nodes: [], sessions: [
  { sessionId: root, mode: 'session' },
  { sessionId: task, mode: 'task', parentSessionId: root, parentToolCallId: 'spawn', executionStatus: 'waiting', waitingForCall: false },
] })

function fixture(t: TestContext) {
  const subscriptions: Array<{ projectId: string; observer: LiveObserver; closed: boolean }> = []
  const requests: Array<{ path: string; signal: AbortSignal; finish: (value: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ path: new URL(url).pathname, signal: init.signal!, finish: value => resolve(Response.json(value)) })
  }))
  const url = new URL('./components/ChatTab.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: 'chat-session-live' })
  const module = { exports: {} as { default: Vue.Component & { render?: () => null } } }
  const require = createRequire(url)
  const code = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)((id: string) => {
    if (id === 'vue') return { ...Vue, onMounted: () => {} }
    if (id.endsWith('.vue')) return { default: {} }
    if (id === 'vue-router') return { useRoute: () => ({ name: 'chat', query: {}, params: {} }), useRouter: () => ({ replace() {} }) }
    if (id === '../composables/useInstallationContext.ts') return { useInstallationContext: () => Vue.ref({ mode: 'main', uiScopes: [] }) }
    if (id === '../composables/useLiveClient.ts') return {
      liveProjectId: (base: string) => new URL(base).pathname.split('/').at(-1),
      useLiveClientPool: () => ({ client: () => ({
        subscribe: (topic: { projectId: string }, observer: LiveObserver) => {
          const subscription = { projectId: topic.projectId, observer, closed: false }
          subscriptions.push(subscription)
          return { ready: async () => {}, close: () => { subscription.closed = true } }
        },
      }) }),
    }
    if (id === '../live-refresh.ts') return {
      createLiveRefresh: (options: Parameters<typeof createLiveRefresh>[0]) => createLiveRefresh({ ...options, delayMs: 0 }),
    }
    return require(id)
  }, module, module.exports, new EventTarget(), new EventTarget())
  module.exports.default.render = () => null
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  function mount(projectId: string, sessionId = root) {
    const navigation: string[] = []
    const props = Vue.reactive({ apiBase: `http://fixture/projects/${projectId}`, projectId, managed: true, sessionId, visible: true })
    let instance: Vue.ComponentPublicInstance | null = null
    const app = renderer.createApp(Vue.defineComponent({
      setup: () => () => Vue.h(module.exports.default, { ...props, onNavigate: (id: string) => navigation.push(id), ref: (value: Vue.ComponentPublicInstance | null) => { instance = value } }),
    }))
    app.mount({})
    let mounted = true
    const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
    t.after(unmount)
    const state = () => { assert.ok(instance); return Reflect.get(instance.$, 'setupState') }
    state().messages = [{ role: 'assistant', event: 'tool_call', toolCallId: 'spawn', toolCall: {
      name: 'subagent', arguments: { mode: 'task', description: 'Delegated task' },
    } }]
    state().inputText = 'Keep this exact unsent draft'
    return { props, state, unmount, navigation }
  }
  const invalidate = (projectId: string) => {
    for (const subscription of subscriptions) if (!subscription.closed && subscription.projectId === projectId) subscription.observer.reset('subscription')
  }
  return { mount, invalidate, requests, subscriptions }
}

test('sessions invalidation refreshes mounted chat graph and metadata-only call waits without reloading or crossing projects', async t => {
  const f = fixture(t)
  const a = f.mount('a')
  const b = f.mount('b')
  f.invalidate('a')
  f.invalidate('b')
  await settle()
  assert.equal(f.requests.length, 2)
  for (const request of f.requests) request.finish(graph())
  await settle()
  assert.equal(f.requests.length, 4)
  for (const request of f.requests.slice(2)) request.finish({ stages: { [root]: 'idle', [task]: 'waiting' }, waitingForCalls: { [task]: false } })
  await settle()
  const stage = (view: typeof a) => sessionActivity(view.state().inlineExecutions.entries.get(0).stage).label
  assert.equal(stage(a), 'Waiting for a response')
  assert.equal(stage(b), 'Waiting for a response')
  f.invalidate('a')
  await settle()
  assert.equal(f.requests.length, 5)
  assert.match(f.requests[4].path, /^\/projects\/a\/api\/sessions\/graph$/)
  f.requests[4].finish(graph())
  await settle()
  f.requests[5].finish({ stages: { [root]: 'idle', [task]: 'waiting' }, waitingForCalls: { [task]: true } })
  await settle()
  assert.equal(stage(a), 'Waiting for call', 'The same mounted reducer observes a metadata-only change')
  assert.equal(stage(b), 'Waiting for a response')
  assert.equal(a.state().inputText, 'Keep this exact unsent draft')
  const poll = a.state().pollSessionStages()
  await settle()
  f.requests[6].finish({ stages: { [root]: 'idle', [task]: 'waiting' }, waitingForCalls: { [task]: false } })
  await poll
  assert.equal(stage(a), 'Waiting for a response', 'Clearing call-wait metadata cannot retain a stale graph flag')
  f.invalidate('a')
  await settle()
  a.props.projectId = 'c'
  a.props.apiBase = 'http://fixture/projects/c'
  await Vue.nextTick()
  assert.equal(f.requests[7].signal.aborted, true)
  assert.equal(f.subscriptions[0].closed, true)
  const stale = graph()
  stale.sessions[1]!.waitingForCall = true
  f.requests[7].finish(stale)
  await settle()
  assert.equal(stage(a), 'Waiting for a response')
  f.invalidate('c')
  await settle()
  f.requests[8].finish(graph())
  await settle()
  const state = a.state()
  a.unmount()
  assert.equal(f.requests[9].signal.aborted, true)
  f.requests[9].finish({ stages: { [task]: 'waiting' }, waitingForCalls: { [task]: true } })
  await settle()
  assert.equal(state.allSessions.find((session: { sessionId: string }) => session.sessionId === task).waitingForCall, false)
  b.props.visible = false
  await Vue.nextTick()
  assert.ok(f.subscriptions.every(subscription => subscription.closed))
})

test('coordinator uses the ordinary writable chat and SSE-discovered topics navigate independently', async t => {
  const f = fixture(t)
  const a = f.mount('a', 'web:orchestrator')
  const b = f.mount('b', 'web:orchestrator')
  assert.equal(f.requests.length, 0, 'Mounting a coordinator does not ensure or send a turn')
  assert.equal(a.state().isDirectChat, true)
  f.invalidate('a')
  await settle()
  f.requests[0]!.finish({ nodes: [], sessions: [
    { sessionId: 'web:orchestrator', sessionKind: 'orchestrator', mode: 'session', parentSessionId: null },
    { sessionId: 'web:chat-topic', sessionKind: 'topic', mode: 'session', parentSessionId: null,
      createdBySessionId: 'web:orchestrator', topic: { title: 'Installer', goal: 'Ship', scope: 'Windows' } },
  ] })
  await settle()
  f.requests[1]!.finish({ stages: {} })
  await settle()
  assert.equal(a.state().allSessions[1].label, 'Installer')
  assert.equal(b.state().allSessions.length, 0, 'Same coordinator ID never shares Project graph state')
  a.state().requestSession('web:chat-topic')
  assert.deepEqual(a.navigation, ['web:chat-topic'])
  assert.equal(a.state().inputText, 'Keep this exact unsent draft')
  assert.equal(f.requests.some(request => /orchestrator$/.test(request.path)), false)
})
