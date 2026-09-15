import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, ref, type Component, type ComponentPublicInstance } from 'vue'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { useModelSelection, type ModelSelection } from './model-selection.ts'
import * as modelSelectionModule from './model-selection.ts'
import type { BotInstanceStatus } from './bot-settings.ts'

function mountScript(t: TestContext, filename: string, props: Record<string, unknown>, probe?: Component, mocks: Record<string, unknown> = {}) {
  const url = new URL(`./components/${filename}`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: filename }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component & { render?: () => ReturnType<typeof h> | null } } }
  const require = createRequire(url)
  new Function('require', 'module', 'exports', 'window', outputText)(
    (id: string) => mocks[id] ?? (id.endsWith('.vue') ? {} : id === '../model-selection.ts' ? modelSelectionModule : require(id)),
    module, module.exports, new EventTarget(),
  )
  module.exports.default.render = () => probe ? h(probe) : null
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  let instance: ComponentPublicInstance | null = null
  const app = renderer.createApp(defineComponent({
    setup: () => () => h(module.exports.default, { ...props, ref: (value: ComponentPublicInstance | null) => { instance = value } }),
  }))
  app.mount({})
  t.after(() => app.unmount())
  return () => {
    assert.ok(instance)
    return Reflect.get(instance.$, 'setupState')
  }
}
const settle = () => new Promise(resolve => setImmediate(resolve))
const config = (model: string) => ({ agent: { model, workspace: 'C:\\synthetic', temperature: .7 }, learning: {} })

test('folder ownership confirmation preserves the source scope, blocks duplicate submits and surfaces busy failures', async t => {
  const organization = { id: 'a', name: 'Original', createdAt: '2026-09-15' }
  const target = { id: 'b', name: 'Destination', createdAt: '2026-09-15' }
  const project = { id: 'folder', name: 'Folder', path: 'C:\\synthetic\\folder', createdAt: '2026-09-15', organizationId: 'a' }
  const requests: Array<{ path: string; init?: RequestInit; resolve: (response: Response) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ path: String(input), init, resolve })
  }))
  const changed: unknown[] = []
  const state = mountScript(t, 'ProjectOwnershipDialog.vue', {
    apiBase: 'http://fixture', organization, organizations: [organization, target], project, action: 'move',
    onChanged: (value: unknown) => { changed.push(value) },
  }, undefined, { vue: { ...Vue, onMounted: () => {} } })
  assert.deepEqual(state().targets.map((org: { id: string }) => org.id), ['b'])
  await state().submit()
  assert.equal(requests.length, 0)
  state().targetId = 'b'
  const first = state().submit()
  await state().submit()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, 'http://fixture/organizations/a/api/projects/folder/move')
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { targetOrganizationId: 'b' })
  requests[0].resolve(Response.json({ error: 'project_busy', message: 'Stop active work in this folder.' }, { status: 409 }))
  await first
  assert.equal(state().busy, false)
  assert.match(state().error, /Stop active work/)
  assert.deepEqual(changed, [])
  const retry = state().submit()
  requests[1].resolve(Response.json({ organizationId: 'b', project: { ...project, id: 'moved', organizationId: 'b' } }))
  await retry
  assert.equal(changed.length, 1)
  assert.equal(state().error, '')
})

test('concurrent model providers retain their immutable org base and ignore another org late load or choices', async t => {
  const requests: Array<{ path: string; resolve: (body: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: URL) => new Promise<Response>(resolve => {
    requests.push({ path: input.pathname, resolve: body => resolve(Response.json(body)) })
  }))
  let a!: ModelSelection, b!: ModelSelection
  const probe = (capture: (selection: ModelSelection) => void) => defineComponent({
    setup() { const selection = useModelSelection(); assert.ok(selection); capture(selection); return () => null },
  })
  const stateA = mountScript(t, 'OrganizationConversation.vue',
    { apiBase: 'http://fixture/organizations/a/', organizationId: 'a', organizationName: 'Same', sessionId: '', visible: true },
    probe(selection => { a = selection }))
  mountScript(t, 'OrganizationConversation.vue',
    { apiBase: 'http://fixture/organizations/b/', organizationId: 'b', organizationName: 'Same', sessionId: '', visible: true },
    probe(selection => { b = selection }))
  const finish = (path: string, body: unknown) => { const request = requests.find(item => item.path === path); assert.ok(request); request.resolve(body) }
  finish('/organizations/b/api/config', config('b-default'))
  finish('/organizations/b/debug/models', { models: ['b-default', 'b-choice'] })
  await settle()
  assert.equal(b.current.value, 'b-default')
  await b.select('b-choice')
  finish('/organizations/a/api/config', config('a-default'))
  finish('/organizations/a/debug/models', { models: ['a-default', 'a-choice'] })
  await settle()
  assert.equal(a.current.value, 'a-default')
  assert.equal(b.current.value, 'b-choice')
  await a.select('a-choice')
  requests.length = 0
  const retry = stateA().load()
  finish('/organizations/a/api/config', config('a-new-default'))
  finish('/organizations/a/debug/models', { models: ['a-new-default', 'a-choice'] })
  await retry
  assert.equal(a.current.value, 'a-choice', 'Reload must not overwrite a pending conversation model choice')
  assert.equal(b.current.value, 'b-choice')
})

test('same-platform bot editors retain separate unsaved names and secrets during status refresh', async t => {
  const bot = (id: string): BotInstanceStatus => ({
    id, organizationId: 'a', platform: 'qq', displayName: 'Same bot', label: 'QQ', enabled: false, configured: true,
    state: 'disabled', config: { appId: id }, secrets: { secret: true },
  })
  let bots = [bot('one'), bot('two')]
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    assert.equal(input.pathname, '/organizations/a/api/channels')
    return Response.json({ channels: bots })
  })
  const state = mountScript(t, 'ChannelsView.vue', { apiBase: 'http://fixture/organizations/a/', organizationId: 'a', active: true, available: true })
  await settle()
  state().configure(state().channels[0])
  state().drafts.one.displayName = 'Edited first bot'
  state().drafts.one.secret = 'synthetic one'
  state().configure(state().channels[1])
  state().drafts.two.secret = 'synthetic two'
  bots = bots.map(item => ({ ...item, state: 'connecting' }))
  await state().refresh(true)
  await nextTick()
  assert.equal(state().drafts.one.displayName, 'Edited first bot')
  assert.equal(state().drafts.one.secret, 'synthetic one')
  assert.equal(state().drafts.two.secret, 'synthetic two')
  assert.equal(state().channels[0].state, 'connecting')
})

test('saving one settings section preserves unsaved fields in other sections of that organization', async t => {
  let saved = {
    ...config('a-default'),
    learning: { enabled: true, reflectIntervalMs: 60_000, encapsulateIntervalMs: 60_000, soulIntervalMs: 60_000 },
  }
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    if (input.pathname === '/api/organizations') {
      return Response.json({ organizations: [{ id: 'a', name: 'Organization A', createdAt: '2026-09-14' }] })
    }
    if (input.pathname.endsWith('/debug/models')) return Response.json({ models: ['a-default'] })
    assert.equal(input.pathname, '/organizations/a/api/config')
    if (init?.method === 'PATCH') saved = JSON.parse(String(init.body))
    return Response.json(saved)
  })
  const state = mountScript(t, 'OrganizationSettings.vue',
    { apiBase: 'http://fixture/organizations/a/', hostApiBase: 'http://fixture', organizationId: 'a' }, undefined, {
      'vue-router': { useRoute: () => ({ name: 'organization-settings', params: { organizationId: 'a', section: 'models' } }) },
      '../composables/useInstallationContext.ts': { useInstallationContext: () => ref({ mode: 'main', uiScopes: ['main:admin'] }) },
    })
  await settle()
  state().learningIntervals.reflectIntervalMs = 7
  state().name = 'Unsaved organization name'
  state().model = 'a-choice'
  await state().saveModels()
  assert.equal(state().error, '')
  assert.equal(saved.agent.model, 'a-choice')
  assert.equal(state().learningIntervals.reflectIntervalMs, 7)
  state().model = 'Unsaved next model'
  state().learningEnabled = false
  await state().saveLearning()
  assert.equal(state().error, '')
  assert.equal(saved.learning.reflectIntervalMs, 420_000)
  assert.equal(saved.learning.enabled, false)
  assert.equal(state().learningRevision, 1)
  assert.equal(state().model, 'Unsaved next model')
  assert.equal(state().name, 'Unsaved organization name')
})

test('a failed organization exposes a real retry and refreshes only its own conversation resources', async t => {
  let ready = false
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    if (input.pathname === '/api/organizations/a/retry') {
      assert.equal(init?.method, 'POST')
      ready = true
      return Response.json({ state: 'ready' })
    }
    if (input.pathname === '/api/organizations/a/status') return Response.json({ state: 'failed' })
    assert.ok(input.pathname.startsWith('/organizations/a/'))
    if (!ready) return new Response('', { status: 503 })
    return Response.json(input.pathname.endsWith('/graph')
      ? { sessions: [{ sessionId: 'web:chat-a' }], nodes: [] } : { stages: {} })
  })
  const state = mountScript(t, 'OrganizationGroup.vue', {
    apiBase: 'http://fixture', organization: { id: 'a', name: 'A', createdAt: '2026-09-14' },
    selectedOrganizationId: 'b', selectedSessionId: 'web:chat-b', remoteFolders: true,
  })
  await settle()
  assert.equal(state().runtimeState, 'failed')
  assert.match(state().error, /Retry organization startup/)
  await state().retryRuntime()
  assert.equal(state().runtimeState, 'ready')
  assert.equal(state().error, '')
  assert.equal(state().sessions[0].sessionId, 'web:chat-a')
})

test('learning status polling cancels hidden organization requests and rejects their late results', async t => {
  const requests: Array<{ path: string; signal: AbortSignal; resolve: (body: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: URL, init?: RequestInit) => new Promise<Response>(resolve => {
    assert.ok(init?.signal)
    requests.push({ path: input.pathname, signal: init.signal, resolve: body => resolve(Response.json(body)) })
  }))
  const a = reactive({ apiBase: 'http://fixture/organizations/a/', organizationId: 'a', active: true })
  const b = reactive({ apiBase: 'http://fixture/organizations/b/', organizationId: 'b', active: false })
  const stateA = mountScript(t, 'LearningRuntimeStatus.vue', a)
  const stateB = mountScript(t, 'LearningRuntimeStatus.vue', b)
  assert.equal(requests.length, 1)
  a.active = false
  b.active = true
  await nextTick()
  assert.equal(requests[0].signal.aborted, true)
  assert.deepEqual(requests.map(request => request.path), ['/organizations/a/api/learning', '/organizations/b/api/learning'])
  const pipeline = { intervalMs: 60_000, pending: false, dispatching: false }
  for (const [index, organizationId] of ['a', 'b'].entries()) {
    requests[index].resolve({ organizationId, enabled: true, stopped: false, pipelines: {
      reflector: pipeline, encapsulator: pipeline, soulReflector: pipeline,
    } })
  }
  await settle()
  assert.equal(stateA().status, undefined)
  assert.equal(stateB().status.organizationId, 'b')
  b.active = false
  await nextTick()
  assert.equal(stateB().status, undefined)
})
