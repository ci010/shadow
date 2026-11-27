import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { createRenderer, defineComponent, h, nextTick, reactive, ref, type Component, type ComponentPublicInstance } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import type { LiveObserver } from './live-client.ts'
import type { ProjectConfig } from './project-settings.ts'

const source = new URL('./components/ProjectSettings.vue', import.meta.url)
const script = compileScript(parse(readFileSync(source, 'utf8')).descriptor, { id: 'settings-lease' })
const code = ts.transpileModule(script.content, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
async function until(check: () => boolean) {
  for (let i = 0; i < 80; i++) { if (check()) return; await delay(5) }
  assert.fail('Timed out waiting for settings state')
}

for (const change of ['newer', 'revoked'] as const) test(`a deferred Project list cannot overwrite ${change} config in the mounted settings view`, async t => {
  const base = `https://settings-${change}.test`
  const listing = Promise.withResolvers<Response>()
  let model = 'initial', reads = 0, closed = 0
  let observer!: LiveObserver
  const pool = {
    client: () => ({ subscribe(_topic: unknown, next: LiveObserver) {
      observer = next; return { ready: async () => {}, close() { closed++ } }
    } }),
    observeHost(_base: string, callback: (status: unknown) => void) { callback({ phase: 'live' }); return () => {} },
  }
  t.mock.method(globalThis, 'fetch', (input: URL) => {
    if (input.pathname === '/api/projects') return listing.promise
    assert.equal(input.pathname, '/projects/p/api/config')
    reads++
    return Promise.resolve(Response.json({ agent: { model, workspace: '/fixture', temperature: 0.1 } }))
  })
  const require = createRequire(source)
  const module = { exports: {} as { default: Component & { render?: () => null } } }
  new Function('require', 'module', 'exports', code)((id: string) => {
    if (id.endsWith('.vue')) return { default: {} }
    if (id === 'vue-router') return { useRoute: () => ({ params: {}, query: {} }) }
    if (id === '../composables/useInstallationContext.ts') return { useInstallationContext: () => ref({ mode: 'main' }) }
    if (id === '../composables/useLiveClient.ts') return { useLiveClientPool: () => pool }
    return require(id)
  }, module, module.exports)
  module.exports.default.render = () => null
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  const props = reactive({ apiBase: `${base}/projects/p`, hostApiBase: base, projectId: 'p', active: true })
  let instance: ComponentPublicInstance | null = null
  const state = () => Reflect.get(instance!.$, 'setupState') as { config?: ProjectConfig; loading: boolean }
  const app = renderer.createApp(defineComponent({ setup: () => () => h(module.exports.default, { ...props, ref: (value: unknown) => { instance = value as ComponentPublicInstance } }) }))
  app.mount({})
  t.after(() => app.unmount())
  await until(() => state().config?.agent.model === 'initial')
  assert.equal(state().loading, true, 'the Project list is still outstanding')
  if (change === 'revoked') {
    observer.reset('project-removed')
    assert.equal(state().config, undefined)
  } else {
    model = 'newer'
    observer.event({ type: 'event', cursor: 'fixture:1', topic: { kind: 'resources', projectId: 'p' }, payload: { event: 'invalidate', resource: 'config' } })
    await until(() => state().config?.agent.model === 'newer')
  }
  listing.resolve(Response.json({ projects: [{ id: 'p', name: 'Project', createdAt: '' }] }))
  await until(() => !state().loading)
  assert.equal(state().config?.agent.model, change === 'newer' ? 'newer' : undefined)
  props.active = false; await nextTick()
  assert.equal(closed, 1, 'a parked settings document releases its config lease')
  assert.equal(state().config, undefined)
  assert.equal(reads, change === 'newer' ? 2 : 1)
})
