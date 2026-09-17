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
import * as projectsModule from './projects.ts'
import { parseSessionGraph } from './folders-sidebar.ts'

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

test('Project session invalidation also refreshes its folder catalog for agent-registered folders', async t => {
  let invalidate: (() => void) | undefined
  t.mock.method(globalThis, 'fetch', async (url: URL) => Response.json(url.pathname.endsWith('/graph')
    ? { sessions: [], nodes: [] } : { stages: {} }))
  const state = mountScript(t, 'ProjectGroup.vue', {
    apiBase: 'http://fixture', project: { id: 'a', name: 'A', createdAt: '' },
    navigationKey: '/projects/a/chat/web:orchestrator', selectedProjectId: 'a',
    selectedSessionId: 'web:orchestrator', remoteFolders: true,
  }, undefined, {
    '../composables/useLiveClient.ts': {
      useLiveClientPool: () => ({ client: () => ({ subscribe: (topic: { projectId: string }, observer: { reset: () => void }) => {
        assert.equal(topic.projectId, 'a')
        invalidate = observer.reset
        return { close() {} }
      } }) }),
    },
  })
  await settle()
  assert.equal(state().liveFolderRevision, 0)
  assert.ok(invalidate)
  invalidate()
  invalidate()
  await new Promise(resolve => setTimeout(resolve, 300))
  assert.equal(state().liveFolderRevision, 1, 'Coalesced session events invalidate the owning folder catalog once')
})

test('folder catalog revision cancels stale lists and moves an agent-created topic into its new folder', async t => {
  const requests: Array<{ signal?: AbortSignal | null; finish: (value: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: URL, init?: RequestInit) => new Promise<Response>(resolve => {
    assert.match(new URL(url).pathname, /^\/projects\/a\/api\/folders$/)
    requests.push({ signal: init?.signal, finish: value => resolve(Response.json(value)) })
  }))
  const props = reactive({
    apiBase: 'http://fixture/projects/a/', grouped: true, projectName: 'A', folderRevision: 0,
    sessions: parseSessionGraph({ sessions: [{ sessionId: 'web:chat-generated', folderId: 'agent-folder', sessionKind: 'topic',
      topic: { title: 'Installer', goal: 'Ship', scope: 'Windows' } }], nodes: [] }),
    activeSessionId: 'web:chat-generated', collapsed: new Set<string>(), stages: {}, sessionsLoading: false, sessionsError: '',
  })
  const state = mountScript(t, 'FoldersSidebar.vue', props, undefined, { vue: { ...Vue, onMounted: () => {} } })
  const stale = state().loadFolders()
  assert.equal(requests.length, 1)
  assert.equal(state().groups.chats.length, 1)
  props.folderRevision++
  await nextTick()
  assert.equal(requests[0]!.signal?.aborted, true)
  assert.equal(requests.length, 2)
  requests[1]!.finish({ folders: [{ id: 'agent-folder', name: 'Agent registered', path: 'C:\\synthetic\\folder', createdAt: '' }] })
  await settle()
  assert.equal(state().groups.chats.length, 0)
  assert.equal(state().groups.folders[0].sessions[0].label, 'Installer')
  requests[0]!.finish({ folders: [] })
  await stale
  await settle()
  assert.equal(state().groups.folders[0].folder.id, 'agent-folder', 'A stale list cannot erase the new registration')
})

function mountAgents(t: TestContext, agentName = 'plan') {
  const route = reactive({
    params: { projectId: 'owner', agentName },
    query: { channel: 'web', retained: 'yes' } as Record<string, string>,
  })
  const requests: Array<{ path: string; signal?: AbortSignal | null; finish: (body: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => new Promise<Response>(resolve => {
    requests.push({
      path: String(input), signal: init?.signal,
      finish: (body, status = 200) => resolve(Response.json(body, { status })),
    })
  }))
  const replace = async (location: { params?: { agentName: string }; query: Record<string, string> }) => {
    route.params = { ...route.params, ...location.params }
    route.query = location.query
    await nextTick()
  }
  const state = mountScript(t, 'AgentsTab.vue', { apiBase: 'http://fixture/projects/owner/' }, undefined, {
    'vue-router': { useRoute: () => route, useRouter: () => ({ replace }) },
  })
  const agents = ['explore', 'plan', 'general'].map(name => ({ name, description: name, source: 'builtin', canSpawn: false }))
  requests[0].finish(agents)
  return { state, requests, route, agents }
}

test('agent deep links load only the requested context and retain details during selection', async t => {
  const { state, requests, route, agents } = mountAgents(t)
  await settle()
  assert.equal(requests.length, 2, 'Do not load the first agent before restoring the deep link')
  assert.match(requests[1].path, /\/plan\/context\?channel=web$/)
  const tools = [{ name: 'read', description: 'Read a file' }]
  requests[1].finish({ systemPrompt: 'Plan prompt', tools })
  await settle()
  state().selectAgent(agents[2])
  await settle()
  assert.equal(route.params.agentName, 'general')
  assert.equal(route.params.projectId, 'owner')
  assert.equal(route.query.retained, 'yes')
  assert.equal(state().loadingContext, true)
  assert.equal(state().selected.name, 'plan', 'Keep the old heading paired with its content while loading')
  assert.equal(state().renderedSystemPrompt, 'Plan prompt', 'Do not collapse the prompt card between selections')
  assert.deepEqual(state().resolvedTools, tools)
  state().selectAgent(agents[2])
  await settle()
  assert.equal(requests.length, 3, 'Reselecting the pending agent must not duplicate the request')
  requests[2].finish({ systemPrompt: 'General prompt', tools: [] })
  await settle()
  assert.equal(state().selected.name, 'general')
  assert.equal(state().renderedSystemPrompt, 'General prompt')
  assert.equal(state().loadingContext, false)
  state().selectAgent(agents[2])
  await settle()
  assert.equal(requests.length, 3, 'Reselecting the displayed agent must not reload it')
})

test('agent route and channel changes cancel stale contexts without letting late responses win', async t => {
  const { state, requests, route, agents } = mountAgents(t)
  await settle()
  requests[1].finish({ systemPrompt: 'Initial', tools: [] })
  await settle()
  state().selectAgent(agents[0])
  await settle()
  route.params.agentName = 'general'
  await settle()
  assert.equal(requests[2].signal?.aborted, true)
  requests[2].finish({ systemPrompt: 'Stale explore', tools: [] })
  await settle()
  assert.equal(state().renderedSystemPrompt, 'Initial')
  assert.equal(state().loadingContext, true)
  route.query.channel = 'discord'
  await settle()
  assert.equal(state().channel, 'discord')
  assert.equal(requests[3].signal?.aborted, true)
  assert.match(requests[4].path, /\/general\/context\?channel=discord$/)
  requests[4].finish({ systemPrompt: 'Latest general', tools: [] })
  await settle()
  requests[3].finish({ systemPrompt: 'Wrong channel', tools: [] })
  await settle()
  assert.equal(state().selected.name, 'general')
  assert.equal(state().renderedSystemPrompt, 'Latest general')
  state().channel = 'feishu'
  await settle()
  assert.equal(route.query.channel, 'feishu')
  assert.equal(route.query.retained, 'yes')
  assert.equal(requests.length, 6, 'Changing the selector fetches context only once')
})

test('failed agent contexts preserve the displayed details and can be retried', async t => {
  const { state, requests, agents } = mountAgents(t)
  await settle()
  requests[1].finish({ systemPrompt: 'Initial', tools: [] })
  await settle()
  state().selectAgent(agents[0])
  await settle()
  requests[2].finish({ error: 'unavailable' }, 503)
  await settle()
  assert.equal(state().selected.name, 'plan')
  assert.equal(state().renderedSystemPrompt, 'Initial')
  assert.match(state().contextError, /503/)
  assert.equal(state().loadingContext, false)
  state().retryContext()
  await settle()
  assert.equal(requests.length, 4)
  requests[3].finish({ systemPrompt: 'Recovered', tools: [] })
  await settle()
  assert.equal(state().selected.name, 'explore')
  assert.equal(state().contextError, '')
})

test('agent entry without a selection loads the default once and aborts pending work on unmount', async t => {
  const { state, requests, route } = mountAgents(t, '')
  await settle()
  assert.equal(route.params.agentName, 'explore')
  assert.equal(requests.length, 2)
  assert.match(requests[1].path, /\/explore\/context\?channel=web$/)
  assert.equal(state().loadingContext, true)
  t.after(async () => {
    assert.equal(requests[1].signal?.aborted, true)
    requests[1].finish({ systemPrompt: 'Late response', tools: [] })
    await settle()
  })
})

test('automation overview creates no draft and run navigation retains project-qualified conversation resources', async t => {
  const route = reactive({
    name: 'chat', fullPath: '/projects/a/chat?automation=daily',
    params: { projectId: 'a', sessionId: '' }, query: { automation: 'daily' } as Record<string, string>,
  })
  type Location = { params?: { projectId?: string; sessionId?: string }; query?: Record<string, string> }
  const navigate = async (location: Location) => {
    route.params = { ...route.params, ...location.params, sessionId: location.params ? location.params.sessionId ?? '' : route.params.sessionId }
    route.query = location.query ?? {}
    route.fullPath = JSON.stringify([route.params, route.query])
    await nextTick()
  }
  const state = mountScript(t, 'ProjectsWorkspace.vue', { apiBase: 'http://fixture', visible: true }, undefined, {
    vue: { ...Vue, onMounted: () => {} },
    'vue-router': { useRoute: () => route, useRouter: () => ({ push: navigate, replace: navigate }) },
    '../composables/useInstallationContext.ts': { useInstallationContext: () => ref({ mode: 'main' }) },
    '../projects.ts': {
      ...projectsModule,
      createProjectsClient: () => ({ list: async () => ['a', 'b'].map(id => ({ id, name: id, createdAt: '2026-09-16' })) }),
    },
  })
  await state().refresh()
  assert.equal(state().selected, undefined)
  assert.equal(state().resources.length, 0, 'An automation is not an unsent chat')
  state().openAutomationRun('cron:run-one')
  await nextTick()
  const first = state().selected
  assert.equal(first.sessionId, 'cron:run-one')
  state().openAutomationRun('cron:run-two')
  await nextTick()
  assert.equal(state().resources.length, 2)
  state().showAutomation('a', 'daily')
  await nextTick()
  assert.equal(state().selected, undefined)
  assert.equal(state().resources.length, 2, 'Overview does not discard cached runs')
  state().openAutomationRun('cron:run-one')
  await nextTick()
  assert.equal(state().selected, first)
  state().showAutomation('b', 'daily')
  await nextTick()
  state().openAutomationRun('cron:run-one')
  await nextTick()
  assert.notEqual(state().selected.key, first.key, 'Matching run IDs across projects stay separate')
  state().identifyAutomation('a', 'cron:run-one', 'wrong-job')
  assert.equal(state().automation.projectId, 'b')
  assert.equal(state().automation.id, 'daily')
  state().startDraft('b')
  await nextTick()
  assert.equal(state().automation, undefined)
  assert.equal(state().selected.sessionId, '')
  assert.equal(route.query.automation, undefined)
})

test('run ownership is canonicalized only from a known graph row and reidentified after route metadata changes', async t => {
  const association = { jobId: 'daily', name: 'Daily review', runId: 'run', startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh' }
  t.mock.method(globalThis, 'fetch', async (input: URL) => Response.json(input.pathname.endsWith('/graph')
    ? { sessions: [{ sessionId: 'cron:run', automation: association }, { sessionId: 'web:chat-normal' }], nodes: [] }
    : { stages: {} }))
  const events: Array<[string, string | undefined]> = []
  const props = reactive({
    apiBase: 'http://fixture', project: { id: 'a', name: 'A', createdAt: '2026-09-16' },
    navigationKey: '/projects/a/chat/cron:run',
    selectedProjectId: 'a', selectedSessionId: 'cron:run', selectedAutomationId: undefined as string | undefined, remoteFolders: false,
    onSessionAutomation: (sessionId: string, jobId?: string) => events.push([sessionId, jobId]),
  })
  mountScript(t, 'ProjectGroup.vue', props)
  await settle()
  assert.deepEqual(events.at(-1), ['cron:run', 'daily'])
  props.selectedAutomationId = 'wrong-link'
  await nextTick()
  assert.deepEqual(events.at(-1), ['cron:run', 'daily'])
  const known = events.length
  props.selectedSessionId = 'not-in-the-snapshot'
  await nextTick()
  assert.equal(events.length, known, 'A missing row cannot erase an explicit deep-link association')
  props.selectedSessionId = 'web:chat-normal'
  await nextTick()
  assert.deepEqual(events.at(-1), ['web:chat-normal', undefined])
})

test('session headers retain resolved context on activation and refresh but never across identity changes', async t => {
  const requests: Array<{ signal?: AbortSignal | null; finish: (value: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (_input: unknown, init?: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ signal: init?.signal, finish: (value, status = 200) => resolve(Response.json(value, { status })) })
  }))
  const props = reactive({
    apiBase: 'http://fixture/projects/a', sessionId: 'heartbeat:reflector-one',
    name: 'Reflection one', physicalId: null as string | null, revision: 0, active: true,
  })
  const details = {
    sessionId: props.sessionId, name: 'Reflection one',
    workdir: { kind: 'local', displayPath: 'C:\\synthetic\\Home' },
    usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null },
  }
  const state = mountScript(t, 'SessionHeading.vue', props)
  requests[0].finish(details)
  await settle()
  assert.equal(state().folder, 'Home')
  props.active = false
  await nextTick()
  assert.equal(state().folder, 'Home')
  props.active = true
  await nextTick()
  assert.equal(state().loading, true)
  assert.equal(state().folder, 'Home')
  requests[1].finish({ error: 'unavailable' }, 503)
  await settle()
  assert.equal(state().folder, 'Home')
  assert.match(state().error, /unavailable/)
  props.revision++
  await nextTick()
  assert.equal(state().folder, 'Home')
  props.apiBase = 'http://fixture/projects/b'
  await nextTick()
  assert.equal(requests[2].signal?.aborted, true)
  assert.equal(state().details, null)
  requests[2].finish(details)
  await settle()
  assert.equal(state().details, null, 'Late old-org details cannot repopulate the new identity')
  requests[3].finish({ ...details, workdir: { kind: 'local', displayPath: 'C:\\synthetic\\OtherHome' } })
  await settle()
  assert.equal(state().folder, 'OtherHome')
  props.physicalId = 'earlier-segment'
  await nextTick()
  assert.equal(state().details, null)
})

test('folder ownership confirmation preserves the source scope, blocks duplicate submits and surfaces busy failures', async t => {
  const project = { id: 'a', name: 'Original', createdAt: '2026-09-15' }
  const target = { id: 'b', name: 'Destination', createdAt: '2026-09-15' }
  const folder = { id: 'folder', name: 'Folder', path: 'C:\\synthetic\\folder', createdAt: '2026-09-15', projectId: 'a' }
  const requests: Array<{ path: string; init?: RequestInit; resolve: (response: Response) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: string, init?: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ path: String(input), init, resolve })
  }))
  const changed: unknown[] = []
  const state = mountScript(t, 'FolderOwnershipDialog.vue', {
    apiBase: 'http://fixture', project, projects: [project, target], folder, action: 'move',
    onChanged: (value: unknown) => { changed.push(value) },
  }, undefined, { vue: { ...Vue, onMounted: () => {} } })
  assert.deepEqual(state().targets.map((org: { id: string }) => org.id), ['b'])
  await state().submit()
  assert.equal(requests.length, 0)
  state().targetId = 'b'
  const first = state().submit()
  await state().submit()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].path, 'http://fixture/projects/a/api/folders/folder/move')
  assert.deepEqual(JSON.parse(String(requests[0].init?.body)), { targetProjectId: 'b' })
  requests[0].resolve(Response.json({ error: 'folder_busy', message: 'Stop active work in this folder.' }, { status: 409 }))
  await first
  assert.equal(state().busy, false)
  assert.match(state().error, /Stop active work/)
  assert.deepEqual(changed, [])
  const retry = state().submit()
  requests[1].resolve(Response.json({ projectId: 'b', folder: { ...folder, id: 'moved', projectId: 'b' } }))
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
  const stateA = mountScript(t, 'ProjectConversation.vue',
    { apiBase: 'http://fixture/projects/a/', projectId: 'a', projectName: 'Same', sessionId: '', visible: true },
    probe(selection => { a = selection }))
  mountScript(t, 'ProjectConversation.vue',
    { apiBase: 'http://fixture/projects/b/', projectId: 'b', projectName: 'Same', sessionId: '', visible: true },
    probe(selection => { b = selection }))
  const finish = (path: string, body: unknown) => { const request = requests.find(item => item.path === path); assert.ok(request); request.resolve(body) }
  finish('/projects/b/api/config', config('b-default'))
  finish('/projects/b/debug/models', { models: ['b-default', 'b-choice'] })
  await settle()
  assert.equal(b.current.value, 'b-default')
  await b.select('b-choice')
  finish('/projects/a/api/config', config('a-default'))
  finish('/projects/a/debug/models', { models: ['a-default', 'a-choice'] })
  await settle()
  assert.equal(a.current.value, 'a-default')
  assert.equal(b.current.value, 'b-choice')
  await a.select('a-choice')
  requests.length = 0
  const retry = stateA().load()
  finish('/projects/a/api/config', config('a-new-default'))
  finish('/projects/a/debug/models', { models: ['a-new-default', 'a-choice'] })
  await retry
  assert.equal(a.current.value, 'a-choice', 'Reload must not overwrite a pending conversation model choice')
  assert.equal(b.current.value, 'b-choice')
})

test('same-platform bot editors retain separate unsaved names and secrets during status refresh', async t => {
  const bot = (id: string): BotInstanceStatus => ({
    id, projectId: 'a', platform: 'qq', displayName: 'Same bot', label: 'QQ', enabled: false, configured: true,
    state: 'disabled', config: { appId: id }, secrets: { secret: true },
  })
  let bots = [bot('one'), bot('two')]
  t.mock.method(globalThis, 'fetch', async (input: URL) => {
    assert.equal(input.pathname, '/projects/a/api/channels')
    return Response.json({ channels: bots })
  })
  const state = mountScript(t, 'ChannelsView.vue', { apiBase: 'http://fixture/projects/a/', projectId: 'a', active: true, available: true })
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

test('saving one settings section preserves unsaved fields in other sections of that project', async t => {
  let saved = {
    ...config('a-default'),
    learning: { enabled: true, reflectIntervalMs: 60_000, encapsulateIntervalMs: 60_000, soulIntervalMs: 60_000 },
  }
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    if (input.pathname === '/api/projects') {
      return Response.json({ projects: [{ id: 'a', name: 'Project A', createdAt: '2026-09-14' }] })
    }
    if (input.pathname.endsWith('/debug/models')) return Response.json({ models: ['a-default'] })
    assert.equal(input.pathname, '/projects/a/api/config')
    if (init?.method === 'PATCH') saved = JSON.parse(String(init.body))
    return Response.json(saved)
  })
  const state = mountScript(t, 'ProjectSettings.vue',
    { apiBase: 'http://fixture/projects/a/', hostApiBase: 'http://fixture', projectId: 'a' }, undefined, {
      'vue-router': { useRoute: () => ({ name: 'project-settings', params: { projectId: 'a', section: 'models' } }) },
      '../composables/useInstallationContext.ts': { useInstallationContext: () => ref({ mode: 'main', uiScopes: ['main:admin'] }) },
    })
  await settle()
  state().learningIntervals.reflectIntervalMs = 7
  state().name = 'Unsaved project name'
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
  assert.equal(state().name, 'Unsaved project name')
})

test('a failed project exposes a real retry and refreshes only its own conversation resources', async t => {
  let ready = false
  t.mock.method(globalThis, 'fetch', async (input: URL, init?: RequestInit) => {
    if (input.pathname === '/api/projects/a/retry') {
      assert.equal(init?.method, 'POST')
      ready = true
      return Response.json({ state: 'ready' })
    }
    if (input.pathname === '/api/projects/a/status') return Response.json({ state: 'failed' })
    assert.ok(input.pathname.startsWith('/projects/a/'))
    if (!ready) return new Response('', { status: 503 })
    return Response.json(input.pathname.endsWith('/graph')
      ? { sessions: [{ sessionId: 'web:chat-a' }], nodes: [] } : { stages: {} })
  })
  const state = mountScript(t, 'ProjectGroup.vue', {
    apiBase: 'http://fixture', project: { id: 'a', name: 'A', createdAt: '2026-09-14' },
    navigationKey: '/projects/b/chat/web:chat-b',
    selectedProjectId: 'b', selectedSessionId: 'web:chat-b', remoteFolders: true,
  })
  await settle()
  assert.equal(state().runtimeState, 'failed')
  assert.match(state().error, /Retry project startup/)
  await state().retryRuntime()
  assert.equal(state().runtimeState, 'ready')
  assert.equal(state().error, '')
  assert.equal(state().sessions[0].sessionId, 'web:chat-a')
})

test('learning status polling cancels hidden project requests and rejects their late results', async t => {
  const requests: Array<{ path: string; signal: AbortSignal; resolve: (body: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: URL, init?: RequestInit) => new Promise<Response>(resolve => {
    assert.ok(init?.signal)
    requests.push({ path: input.pathname, signal: init.signal, resolve: body => resolve(Response.json(body)) })
  }))
  const a = reactive({ apiBase: 'http://fixture/projects/a/', projectId: 'a', active: true })
  const b = reactive({ apiBase: 'http://fixture/projects/b/', projectId: 'b', active: false })
  const stateA = mountScript(t, 'LearningRuntimeStatus.vue', a)
  const stateB = mountScript(t, 'LearningRuntimeStatus.vue', b)
  assert.equal(requests.length, 1)
  a.active = false
  b.active = true
  await nextTick()
  assert.equal(requests[0].signal.aborted, true)
  assert.deepEqual(requests.map(request => request.path), ['/projects/a/api/learning', '/projects/b/api/learning'])
  const pipeline = { intervalMs: 60_000, pending: false, dispatching: false }
  for (const [index, projectId] of ['a', 'b'].entries()) {
    requests[index].resolve({ projectId, enabled: true, stopped: false, pipelines: {
      reflector: pipeline, encapsulator: pipeline, soulReflector: pipeline,
    } })
  }
  await settle()
  assert.equal(stateA().status, undefined)
  assert.equal(stateB().status.projectId, 'b')
  b.active = false
  await nextTick()
  assert.equal(stateB().status, undefined)
})
