import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createLiveRefresh } from './live-refresh.ts'
import type { LiveObserver, LiveStatus } from './live-client.ts'

test('scheduled inventory ignores history and healthy idle ticks; automation updates and disconnect fallback still read', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const document = Object.assign(new EventTarget(), { hidden: false })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: document })
  t.after(() => { if (previous) Object.defineProperty(globalThis, 'document', previous); else Reflect.deleteProperty(globalThis, 'document') })
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return Response.json({ sessionId: 'web:one', tasks: [] })
  })
  const subscriptions: Array<{ kind: string; observer: LiveObserver; closed: boolean }> = []
  let host!: (status: LiveStatus) => void
  const url = new URL('./components/ScheduledTasks.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'scheduled', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', outputText)((id: string) => {
    if (id === '../composables/useLiveClient.ts') return {
      liveProjectId: () => 'a',
      useLiveClientPool: () => ({
        observeHost: (_base: string, callback: typeof host) => { host = callback; callback({ phase: 'live' }); return () => {} },
        client: () => ({ subscribe: (topic: { kind: string }, observer: LiveObserver) => {
          const entry = { kind: topic.kind, observer, closed: false }; subscriptions.push(entry)
          return { ready: async () => {}, close() { entry.closed = true } }
        } }),
      }),
    }
    if (id === '../live-refresh.ts') return { createLiveRefresh: (options: Parameters<typeof createLiveRefresh>[0]) => createLiveRefresh({ ...options, delayMs: 0 }) }
    return require(id)
  }, module, module.exports)
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  const props = reactive({ apiBase: 'http://fixture/projects/a', sessionId: 'web:one', active: true })
  const app = renderer.createApp(defineComponent({ setup: () => () => h(module.exports.default, props) }))
  app.mount({})
  t.after(() => app.unmount())
  const tick = () => new Promise(resolve => setTimeout(resolve, 15))
  const event = (kind: string, payload: unknown) => subscriptions.find(entry => entry.kind === kind)!.observer.event({
    type: 'event', cursor: 'fixture:1', topic: { kind: 'sessions', projectId: 'a' }, payload,
  })
  await tick()
  assert.equal(calls, 1)
  event('sessions', { event: 'invalidate', sessionId: 'web:one', changes: ['history', 'work'] })
  t.mock.timers.tick(60_000)
  await tick()
  assert.equal(calls, 1, 'healthy idle and ordinary turn notifications do not reread scheduled tasks')
  event('resources', { event: 'invalidate', resource: 'automations' })
  await tick()
  assert.equal(calls, 2)
  host({ phase: 'error' })
  t.mock.timers.tick(30_000)
  await tick()
  assert.equal(calls, 3)
  props.active = false
  await nextTick()
  assert.ok(subscriptions.every(entry => entry.closed))
})
