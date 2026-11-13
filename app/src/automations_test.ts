import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, inject, nextTick, reactive, ref, type Component, type ComponentPublicInstance } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { AUTOMATION_PAGE_SIZE, fetchAutomations, fetchAutomationRuns, learningOutcomeLabel, setAutomationEnabled } from './automations.ts'
import { createLiveRefresh } from './live-refresh.ts'
import type { LiveObserver } from './live-client.ts'
import { createAutomationCatalog } from './automation-catalog.ts'
import { createAutomationRunHistory } from './automation-run-history.ts'
import * as automationConversationModule from './composables/useAutomationConversation.ts'

const base = 'http://fixture/projects/a'
const automation = (id = 'cron:weekly') => ({
  id, name: 'Weekly review', source: 'cron', session: 'fresh', schedule: '0 9 * * 1', task: 'Review recent work', enabled: true,
})
const run = (id = 'one') => ({
  id, sessionId: `web:run-${id}`, startedAt: '2026-09-15T10:30:00.123Z', status: 'completed',
})
const page = (runs: unknown[] = [run()], total = runs.length, offset = 0) => ({ runs, total, offset })
const signal = () => new AbortController().signal
const settle = () => new Promise(resolve => setTimeout(resolve, 30))
const response = (value: unknown): typeof fetch => async () => Response.json(value)

test('automation workspace delegates to the ordinary conversation without a runs explorer or tab strip', () => {
  const { descriptor } = parse(readFileSync(new URL('./components/AutomationDetail.vue', import.meta.url), 'utf8'))
  const style = descriptor.styles.map(style => style.content).join('\n')
  assert.match(style, /\.automation-detail\s*\{[^}]*\bflex:\s*1\s*;/)
  assert.match(descriptor.template!.content, /<slot\s*\/>/)
  assert.doesNotMatch(descriptor.template!.content, /automation-explorer|automation-toolbar|role="tab"|<aside/)
})

test('run titles remain available as data without introducing a run list', async t => {
  const view = mount(t)
  await settle()
  const title = 'Long persisted prompt line\n'.repeat(100)
  view.finish(0, page([{ ...run(), title }]))
  await settle()
  assert.equal(view.props.selectedSessionId, run().sessionId)
  assert.equal(view.state().history.runs[0].title, title)
  assert.doesNotMatch(view.text(), /Long persisted prompt line/)
})

test('automation clients retain org scope, encode IDs and strip non-summary fields', async () => {
  const request: typeof fetch = async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/projects/a/api/automations')
    assert.equal(init?.cache, 'no-store')
    assert.ok(init?.signal)
    return Response.json({ automations: [{ ...automation(), secret: 'fixture extra' }, { ...automation('learning'), source: 'learning', enabled: false }] })
  }
  const items = await fetchAutomations(`${base}/?ignored=yes`, signal(), request)
  assert.equal(items.length, 2)
  assert.equal(items[1].enabled, false)
  assert.equal('secret' in items[0], false)
  const history = await fetchAutomationRuns(base, 'job:/a?b', 30, signal(), async (input, init) => {
    const url = new URL(String(input))
    assert.equal(url.pathname, '/projects/a/api/automations/job%3A%2Fa%3Fb/runs')
    assert.equal(url.searchParams.get('offset'), '30')
    assert.equal(url.searchParams.get('limit'), String(AUTOMATION_PAGE_SIZE))
    assert.equal(init?.cache, 'no-store')
    return Response.json(page([{ ...run(), status: 'unknown', title: 'Persisted title', messages: ['not a summary'] }], 31, 30))
  })
  assert.equal(history.runs[0].status, 'unknown')
  assert.equal(history.runs[0].title, 'Persisted title')
  assert.equal('messages' in history.runs[0], false)
})

test('automation inventory rejects wrong modes, types, duplicate identities and malformed envelopes', async () => {
  for (const value of [
    {}, { automations: null }, { automations: [null] }, { automations: [automation(), automation()] },
    ...[
      { source: 'reflector' }, { session: 'existing' }, { enabled: 'true' },
      { id: '..' }, { name: '' }, { schedule: null }, { task: {} }, { agentType: 4 },
    ].map(change => ({ automations: [{ ...automation(), ...change }] })),
  ]) await assert.rejects(fetchAutomations(base, signal(), response(value)), /invalid workflow data/)
})

test('learning outcomes remain distinct from session completion and validate receipt data', async () => {
  for (const status of ['applied', 'no_change', 'partial', 'blocked', 'draft_only'] as const) {
    const learning = { status, summary: 'Evidence reviewed.\nThe reason remains conditional.', artifacts: 1, events: 2, evaluated: 1 }
    const result = await fetchAutomationRuns(base, 'learning:reflector', 0, signal(), response(page([{ ...run(), learning }])))
    assert.equal(result.runs[0].status, 'completed')
    assert.deepEqual(result.runs[0].learning, learning)
    assert(learningOutcomeLabel(learning))
  }
  for (const learning of [null, {}, { status: 'success' }, {
    status: 'applied', summary: 'Invalid count', artifacts: -1, events: 0, evaluated: 0,
  }]) await assert.rejects(fetchAutomationRuns(base, 'learning:reflector', 0, signal(), response(page([{ ...run(), learning }]))), /invalid workflow data/)
  assert.equal((await fetchAutomationRuns(base, 'learning:reflector', 0, signal(), response(page()))).runs[0].learning, undefined)
})

test('learning conversations show partial outcomes and keep legacy completion unverified', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([{ ...run(), learning: {
    status: 'partial', summary: 'One decision saved; remaining evidence unread.', artifacts: 1, events: 1, evaluated: 0,
  } }, run('legacy')]), { ...automation(), source: 'learning' })
  await settle()
  assert.equal(view.state().run.learning.status, 'partial')
  assert.doesNotMatch(view.text(), /One decision saved|Execution:|Check frequency/)
  view.props.selectedSessionId = run('legacy').sessionId
  await nextTick()
  assert.equal(view.state().run.learning, undefined)

})

test('runs reject malformed dates, counts, scope offsets, duplicate sessions and unknown wire enums', async () => {
  for (const value of [
    {}, { ...page(), offset: 30 }, { ...page(), total: 2 }, { ...page(), total: -1 }, { ...page(), total: 1.5 },
    page([run(), run()]), page([run(), { ...run('two'), sessionId: run().sessionId }]),
    ...[
      { status: 'success' }, { startedAt: 'yesterday' }, { startedAt: '2026-02-30T10:30:00Z' },
      { startedAt: '2026-09-16' }, { startedAt: '2026-09-16T25:00:00Z' },
      { sessionId: '' }, { title: 1 },
    ].map(change => page([{ ...run(), ...change }])),
  ]) await assert.rejects(fetchAutomationRuns(base, 'weekly', 0, signal(), response(value)), /invalid workflow data/)
  for (const offset of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fetchAutomationRuns(base, 'weekly', offset, signal(), response(page())), /invalid workflow data/)
  }
  await assert.rejects(fetchAutomationRuns(base, '..', 0, signal(), response(page())), /invalid workflow data/)
  assert.equal((await fetchAutomationRuns(base, 'weekly', 60, signal(), response(page([], 31, 60)))).runs.length, 0)
  const ordered = await fetchAutomationRuns(base, 'weekly', 0, signal(), response(page([
    run('older'), { ...run('newer'), startedAt: '2026-09-16T01:00:00+02:00' },
  ])))
  assert.equal(ordered.runs[0].id, 'newer')
})

test('errors are safe, 404 explicitly requests upgrade, and cancelled reads cannot succeed', async t => {
  for (const [request, expected] of [
    [async () => new Response('private upstream body', { status: 404 }), /Update and restart Main/],
    [async () => Response.json({ error: 'private' }, { status: 403 }), /denied/],
    [async () => Response.json({}, { status: 503 }), /Check Main and retry/],
    [async () => new Response('{invalid'), /invalid workflow data/],
    [async () => { throw new TypeError('private host detail') }, /Check Main and retry/],
  ] as const) await assert.rejects(fetchAutomations(base, signal(), request), expected)
  const controller = new AbortController()
  await assert.rejects(fetchAutomations(base, controller.signal, async (_input, init) => {
    controller.abort()
    assert.equal(init?.signal?.aborted, true)
    return Response.json({ automations: [] })
  }), { name: 'AbortError' })
  let requested = false
  await assert.rejects(fetchAutomations(base, controller.signal, async () => { requested = true; return Response.json({ automations: [] }) }), { name: 'AbortError' })
  assert.equal(requested, false)
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => {
    assert.equal(milliseconds, 15_000)
    return AbortSignal.abort(new DOMException('Synthetic deadline', 'TimeoutError'))
  })
  await assert.rejects(fetchAutomations(base, signal(), response({ automations: [] })), /timed out/)
})

function mount(t: TestContext, active = true, withSidebar = false) {
  const requests: Array<{ url: URL; signal: AbortSignal; init: RequestInit; finish: (value: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (input: URL, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: new URL(String(input)), signal: init.signal!, init, finish: (value, status = 200) => resolve(Response.json(value, { status })) })
  }))
  const documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'document')
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible', getElementById: () => null })
  Object.defineProperty(globalThis, 'document', { configurable: true, value: visibility })
  const resizeDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver')
  Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} disconnect() {} } })
  t.after(() => {
    if (documentDescriptor) Object.defineProperty(globalThis, 'document', documentDescriptor)
    else Reflect.deleteProperty(globalThis, 'document')
    if (resizeDescriptor) Object.defineProperty(globalThis, 'ResizeObserver', resizeDescriptor)
    else Reflect.deleteProperty(globalThis, 'ResizeObserver')
  })
  const intervals = new Map<number, () => void>()
  let timerId = 0
  t.mock.method(globalThis, 'setInterval', (callback: () => void, delay: number) => {
    assert.equal(delay, 20_000)
    intervals.set(++timerId, callback)
    return timerId
  })
  t.mock.method(globalThis, 'clearInterval', (id: number) => { intervals.delete(id) })
  const subscriptions: Array<{ base: string; topic: unknown; observer: LiveObserver; closed: boolean }> = []
  const catalog = createAutomationCatalog({ client: (base: string) => ({
    subscribe: (topic: unknown, observer: LiveObserver) => {
      const entry = { base, topic, observer, closed: false }
      subscriptions.push(entry)
      return { ready: async () => {}, close: () => { entry.closed = true } }
    },
  }) } as Parameters<typeof createAutomationCatalog>[0], { delayMs: 0 })
  t.after(() => catalog.dispose())
  const props = reactive({ apiBase: base, automationId: automation().id, active, selectedSessionId: '', enabled: true })
  const opens: string[] = []
  function component(filename: string) {
    const url = new URL(`./components/${filename}`, import.meta.url)
    const { descriptor } = parse(readFileSync(url, 'utf8'))
    const script = compileScript(descriptor, { id: filename })
    const template = compileTemplate({ source: descriptor.template!.content, filename: url.pathname, id: filename,
      compilerOptions: { bindingMetadata: script.bindings } })
    assert.deepEqual(template.errors, [])
    const { outputText, diagnostics } = ts.transpileModule(script.content, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }, reportDiagnostics: true,
    })
    assert.deepEqual(diagnostics, [])
    const module = { exports: {} as { default: Component & { render?: Function } } }
    const require = createRequire(url)
    new Function('require', 'module', 'exports', outputText)((id: string) => {
      if (id.endsWith('/HoverInfo.vue')) return { default: defineComponent({
        props: ['text', 'label', 'interactive', 'disabled'],
        setup: (_props, { slots }) => {
          const opened = ref(false)
          return () => h('span', { class: 'hover-info-test', onPointerenter: () => { opened.value = true } }, [
            slots.default?.({ triggerProps: {}, close: () => {} }),
            opened.value ? h('div', { class: 'hover-info-test-popup' }, slots.content?.({ close: () => {} })) : null,
          ])
        },
      }) }
      if (id === 'vue-router') return { RouterLink: defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { 'data-route': JSON.stringify(props.to) }, slots.default?.()) }) }
      if (id.endsWith('/TreeRow.vue')) return { default: component('TreeRow.vue') }
      if (id.endsWith('/AutomationConversationInfo.vue')) return { default: component('AutomationConversationInfo.vue') }
      if (id === '../composables/useAutomationConversation.ts') return automationConversationModule
      if (id.endsWith('.vue')) return { default: defineComponent({ setup: () => () => null }) }
      if (id === '../live-refresh.ts') return {
        createLiveRefresh: (options: Parameters<typeof createLiveRefresh>[0]) => createLiveRefresh({ ...options, delayMs: 0 }),
      }
      if (id === '../automation-run-history.ts') return {
        ...require(id),
        createAutomationRunHistory: (base: string, id: string, state: Parameters<typeof createAutomationRunHistory>[2]) =>
          createAutomationRunHistory(base, id, state, { delayMs: 0 }),
      }
      return require(id)
    }, module, module.exports)
    const renderModule = { exports: {} as { render: Function } }
    const renderCode = ts.transpileModule(template.code, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText
    new Function('require', 'module', 'exports', renderCode)(require, renderModule, renderModule.exports)
    module.exports.default.render = renderModule.exports.render
    return module.exports.default
  }
  const detail = component('AutomationDetail.vue')
  const info = component('AutomationConversationInfo.vue')
  const conversation = defineComponent({
    setup() {
      const context = inject(automationConversationModule.automationConversationKey)!
      return () => context.sessionId.value ? h(info, { conversation: context }) : null
    },
  })
  const sidebar = withSidebar ? component('AutomationSidebar.vue') : undefined
  const sidebarProps = reactive({ projectId: 'a', apiBase: base, active, groups: [], stages: {} })
  interface TreeNode { type: string; text: string; style: Record<string, string>; props: Record<string, unknown>; children: TreeNode[]; parent: TreeNode | null }
  const node = (type: string, text = ''): TreeNode => ({ type, text, style: {}, props: {}, children: [], parent: null })
  const root = node('root')
  const renderer = createRenderer<TreeNode, TreeNode>({
    createElement: type => node(type), createText: text => node('text', text), createComment: () => node('comment'),
    insert(child, parent, anchor) {
      if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1)
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, child)
      child.parent = parent
    },
    remove(child) { if (child.parent) child.parent.children.splice(child.parent.children.indexOf(child), 1); child.parent = null },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, next) => { node.props[key] = next },
    parentNode: node => node.parent,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  let instance: ComponentPublicInstance | null = null
  const app = renderer.createApp(defineComponent({
    setup: () => () => [
      ...(sidebar ? [h(sidebar, sidebarProps)] : []),
      h(detail, { ...props, onOpen: (id: string, replace: boolean) => {
        if (!replace) opens.push(id)
        props.selectedSessionId = id
      }, ref: (value: ComponentPublicInstance | null) => { instance = value } },
      { default: () => h(conversation) }),
    ],
  }))
  app.provide(Symbol.for('shadow.automation-catalog'), catalog)
  app.mount(root)
  // Workflow navigation is expanded by default, including an empty catalog.
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); mounted = false } }
  t.after(unmount)
  const state = () => {
    assert.ok(instance)
    const setup = Reflect.get(instance.$, 'setupState')
    return new Proxy(setup, { get(target, key) {
      if (key === 'runs') return target.history.runs
      if (key === 'run') return target.conversation.run.value
      if (key === 'error') return target.error || target.historyError
      return Reflect.get(target, key)
    } })
  }
  const finish = (from = 0, runs = page(), item = automation()) => {
    const batch = requests.slice(from, from + 2)
    batch.find(request => request.url.pathname.endsWith('/api/automations'))!.finish({ automations: [item] })
    batch.find(request => request.url.pathname.endsWith('/runs'))!.finish(runs)
  }
  const invalidate = () => subscriptions.at(-1)!.observer.reset('subscription')
  const setVisible = (value: boolean) => { visibility.visibilityState = value ? 'visible' : 'hidden'; visibility.dispatchEvent(new Event('visibilitychange')) }
  const nodes = (parent = root): TreeNode[] => [parent, ...parent.children.flatMap(child => nodes(child))]
  const text = () => nodes().map(node => node.text).join(' ')
  return { props, sidebarProps, requests, subscriptions, state, invalidate, unmount, finish, intervals, setVisible, opens, nodes, text }
}

test('single Workflow navigation does not own catalog polling or depend on automation history', async t => {
  const view = mount(t, true, true)
  await settle()
  assert.equal(view.requests.length, 2, 'Only the open conversation owns catalog/run reads')
  assert.equal(view.nodes().filter(node => node.type === 'nav' && node.props['aria-label'] === 'Workflows').length, 1)
  assert.ok(view.nodes().some(node => node.type === 'a' && String(node.props['data-route']).includes('project-workflows')))
  assert.equal(view.nodes().filter(node => node.props['data-automation-id']).length, 0)
  view.finish()
  await settle()
  view.props.active = false
  await nextTick()
  assert.ok(view.subscriptions.every(subscription => subscription.closed), 'Navigation does not retain a catalog lease')
  assert.equal(view.intervals.size, 0)
  assert.equal(view.nodes().filter(node => node.type === 'nav' && node.props['aria-label'] === 'Workflows').length, 1)
  view.sidebarProps.projectId = 'b'
  await nextTick()
  assert.ok(view.nodes().some(node => node.type === 'a' && String(node.props['data-route']).includes('"projectId":"b"')))
})

test('component uses shared sessions, coalesces invalidations and renders authoritative unknown status', async t => {
  const view = mount(t)
  await settle()
  assert.deepEqual(view.subscriptions[0].topic, { kind: 'sessions', projectId: 'a' })
  for (let i = 0; i < 20; i++) view.invalidate()
  await settle()
  assert.equal(view.requests.length, 2, 'one paired snapshot in flight')
  view.finish(0, page([{ ...run(), status: 'unknown' }]))
  await settle()
  assert.equal(view.state().runs[0].status, 'unknown')
  assert.equal(view.props.selectedSessionId, '', 'Default selection waits for the coalesced refresh to finish')
  assert.equal(view.requests.length, 4, 'one coalesced follow-up')
  view.finish(2, page([{ ...run(), status: 'unknown' }]))
  await settle()
  assert.equal(view.state().position.run.status, 'unknown')
  assert.match(view.text(), /Status unknown/)
  assert.equal(view.requests.length, 4)
  assert.equal(view.intervals.size, 1)
  view.intervals.values().next().value!()
  await settle()
  assert.equal(view.requests.length, 6)
})

test('project and job changes clear stale data, abort reads, and ignore late results', async t => {
  const view = mount(t)
  await settle()
  view.finish()
  await settle()
  view.invalidate()
  await settle()
  view.props.apiBase = 'http://fixture/projects/b'
  await nextTick()
  assert.equal(view.state().automation, null)
  assert.deepEqual(view.state().runs, [])
  assert.equal(view.subscriptions[0].closed, true)
  assert.ok(view.requests.slice(2, 4).every(request => request.signal.aborted))
  await settle()
  assert.match(String(view.requests[4].url), /projects\/b/)
  view.finish(4, page([run('b')]))
  view.finish(2, page([run('old')]))
  await settle()
  assert.equal(view.state().runs[0].id, 'b')
  view.props.automationId = 'learning'
  await nextTick()
  assert.equal(view.state().automation, null)
  await settle()
  assert.equal(view.requests.length, 7, 'Changing jobs reuses the project catalog')
  view.requests[6].finish(page([run('learning')]))
  view.state().refresh()
  await settle()
  view.finish(7, page([run('learning')]), { ...automation('learning'), source: 'learning' })
  await settle()
  assert.equal(view.state().automation.source, 'learning')
})

test('history navigation appends pages while keeping the selected independent conversation', async t => {
  const view = mount(t)
  view.props.selectedSessionId = 'web:run-29'
  await settle()
  const first = Array.from({ length: 30 }, (_, index) => run(String(index)))
  view.finish(0, page(first, 31))
  await settle()
  view.state().navigation.previous()
  await nextTick()
  await settle()
  assert.equal(view.requests[2].url.searchParams.get('offset'), '30')
  assert.equal(view.state().runs.length, 30)
  assert.equal(view.props.selectedSessionId, 'web:run-29')
  view.requests[2].finish(page([run('last')], 31, 30))
  await settle()
  assert.equal(view.props.selectedSessionId, 'web:run-last')
  view.props.selectedSessionId = 'web:historical-outside-page'
  await nextTick()
  assert.equal(view.state().history.nextOffset, 31)
  assert.equal(view.state().runs.length, 31)
  assert.match(view.state().historyError, /no longer in the automation history/)
  assert.equal(view.requests.length, 3, 'Pagination does not reload the catalog')
  assert.deepEqual(view.opens, ['web:run-last'])
  assert.equal(view.props.selectedSessionId, 'web:historical-outside-page')
  assert.equal(view.nodes().some(node => node.props.role === 'tab'), false)
})

test('inactive, document-hidden and unmounted views release all scoped resources', async t => {
  const view = mount(t, false)
  await settle()
  assert.equal(view.requests.length, 0)
  view.props.active = true
  await nextTick()
  await settle()
  view.setVisible(false)
  await nextTick()
  assert.equal(view.intervals.size, 0)
  assert.equal(view.subscriptions[0].closed, true)
  assert.ok(view.requests.every(request => request.signal.aborted))
  view.setVisible(true)
  await nextTick()
  await settle()
  assert.equal(view.requests.length, 4)
  view.props.active = false
  await nextTick()
  assert.equal(view.intervals.size, 0)
  view.props.active = true
  await nextTick()
  await settle()
  const state = view.state()
  view.unmount()
  assert.equal(view.intervals.size, 0)
  assert.ok(view.subscriptions.every(subscription => subscription.closed))
  assert.ok(view.requests.every(request => request.signal.aborted))
  view.finish(4)
  await settle()
  assert.equal(state.automation, null)
})

test('upgrade, invalid and missing automation errors are retryable and never become empty success', async t => {
  const view = mount(t)
  await settle()
  view.requests[0].finish({}, 404)
  view.requests[1].finish({}, 404)
  await settle()
  assert.match(view.state().error, /Update and restart Main/)
  assert.match(view.text(), /Update and restart Main/)
  assert.equal(view.state().loading, false)
  view.state().refresh()
  await settle()
  view.finish(2, page([]))
  await settle()
  assert.equal(view.state().error, '')
  assert.deepEqual(view.state().runs, [])
  view.props.selectedSessionId = ''
  await nextTick()
  view.invalidate()
  await settle()
  view.requests[4].finish({ automations: [] })
  view.requests[5].finish(page())
  await settle()
  assert.match(view.state().error, /no longer available/)
  assert.equal(view.state().automation, null)
  view.state().refresh()
  await settle()
  view.finish(6, { ...page(), total: 100 })
  await settle()
  assert.match(view.state().error, /invalid workflow data/)
})

test('conversation status omits configuration and leaves the saved run intact', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([{ ...run(), status: 'failed', title: 'Saved conversation title' }]), {
    ...automation(), source: 'learning', enabled: false,
  })
  await settle()
  assert.doesNotMatch(view.text(), /Dispatch is disabled|Review recent work|Check frequency|activity-gated|each dispatch/)
  assert.equal(view.props.selectedSessionId, run().sessionId)
  assert.equal(view.state().run.status, 'failed')
  assert.deepEqual(view.opens, [])
  assert.equal(view.nodes().some(node => node.props.class === 'automation-info' || node.props.class === 'automation-context'), false)
  assert.equal(view.requests.length, 2)
})

test('an automation with no runs shows its empty state without configuration or a draft', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([]))
  await settle()
  assert.equal(view.props.selectedSessionId, '')
  assert.deepEqual(view.opens, [])
  assert.match(view.text(), /No saved runs yet/)
  assert.doesNotMatch(view.text(), /Review recent work|Check frequency/)
  assert.equal(view.nodes().some(node => node.props.class === 'automation-info'), false)
})

test('previous, next and current select sessions without accumulating open run tabs', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([run('first'), run('second'), run('third')]))
  await settle()
  assert.equal(view.props.selectedSessionId, 'web:run-first')
  view.state().navigation.previous()
  await nextTick()
  view.state().navigation.previous()
  await nextTick()
  view.state().navigation.next()
  await nextTick()
  view.state().navigation.current()
  await nextTick()
  assert.deepEqual(view.opens, ['web:run-second', 'web:run-third', 'web:run-second', 'web:run-first'])
  assert.equal(view.state().position.historical, false)
  assert.equal(view.nodes().some(node => node.props.role === 'tab'), false)
})

test('history refresh failures preserve the selected conversation and expose retry inline', async t => {
  const view = mount(t)
  await settle()
  assert.match(view.text(), /Loading conversation/)
  view.finish()
  await settle()
  const original = view.state().history.runs
  view.invalidate()
  await settle()
  assert.equal(view.state().history.runs, original)
  assert.equal(view.props.selectedSessionId, run().sessionId)
  view.requests[2].finish({ automations: [automation()] })
  view.requests[3].finish({}, 503)
  await settle()
  assert.equal(view.state().history.runs, original)
  assert.match(view.text(), /Retry history/)
  const retry = view.nodes().find(node => node.type === 'button' && node.text === 'Retry history')
  assert.ok(retry)
  ;(retry.props.onClick as () => void)()
  await settle()
  assert.equal(view.requests.length, 5, 'Retrying history does not refetch the catalog')
  view.requests[4].finish(page())
  await settle()
  assert.equal(view.state().historyError, '')
  assert.equal(view.props.selectedSessionId, run().sessionId)
})

test('Workflow entry stays navigation-only under master suppression', async t => {
  const view = mount(t, true, true)
  await settle()
  view.finish(0, page(), { ...automation(), enabled: false, configuredEnabled: true, editable: true, disabledByGlobal: true })
  await settle()
  const nav = view.nodes().find(node => node.type === 'nav' && node.props['aria-label'] === 'Workflows')!
  assert.ok(nav)
  assert.equal(view.nodes(nav).filter(node => node.type === 'a').length, 1)
  assert.equal(view.nodes(nav).filter(node => node.type === 'button' || node.type === 'input').length, 0)
  assert.ok(view.requests.every(request => request.init.method !== 'PATCH'))
})

test('automation updates use scoped PATCH and only send the item preference', async () => {
  let called = false
  await setAutomationEnabled('http://fixture/projects/a', 'learning:reflector', false, new AbortController().signal, async (input, init) => {
    called = true
    assert.equal(new URL(String(input)).pathname, '/projects/a/api/automations/learning%3Areflector')
    assert.equal(init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(init?.body)), { enabled: false })
    return Response.json({ automation: { id: 'learning:reflector' } })
  })
  assert.equal(called, true)
})


test('system automation renders scoped coverage history with stable feature controls', async t => {
  const view = mount(t, true, true)
  await settle()
  const partial = { ...run(), title: '话题增量整理', scope: 'delta', organizationProblem: 'unfinished', organization: {
    mode: 'delta', status: 'partial', coveredCount: 1, manifestCount: 3, patches: 1,
  } }
  const full = { ...run('full'), title: '话题全量重整', scope: 'full' }
  view.finish(0, page([partial, full]), { ...automation(), source: 'system', canToggle: true, name: '话题整理', task: undefined, enabled: false, configuredEnabled: false, editable: true } as ReturnType<typeof automation>)
  await settle()
  assert.match(view.text(), /Organization ended without finishing/)
  assert.doesNotMatch(view.text(), /Inactive/, 'Removed sidebar automation rows do not duplicate runtime state')
  assert.doesNotMatch(view.text(), /Execution history|Coverage|Controls this automation feature/)
  assert.equal(view.state().history.runs.length, 2)
  assert.equal(view.state().run.organization.status, 'partial')
  assert.equal(view.state().run.organization.coveredCount, 1)
  assert.equal(view.state().run.organization.manifestCount, 3)
})


test('internal prompts and semantic execution output are disclosed, never default transcript dumps', () => {
  const { descriptor } = parse(readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8'))
  const template = descriptor.template!.content
  const internalDisclosure = template.match(/<AutomationPayload v-if="automationConversation\?\.automation\.value\?\.source === 'system'[^>]*\/>/)?.[0]
  assert.ok(internalDisclosure)
  assert.match(internalDisclosure, /:source="msg\.content"/)
  const payload = readFileSync(new URL('./components/AutomationPayload.vue', import.meta.url), 'utf8')
  assert.match(payload, /Execution input/)
  assert.match(payload, /Execution output/)
  assert.match(payload, /ToolPayload v-if="open"[^>]*boxed/)
  assert.match(payload, /const open = ref\(false\)/)
  assert.doesNotMatch(payload, /renderMarkdown/)
})

for (const feature of ['system:work-organizer']) {
  for (const enabled of [true, false]) {
    test(`system feature ${feature} keeps preference controls in the Workflow graph, not navigation`, async t => {
      const view = mount(t, true, true)
      view.props.automationId = feature
      await settle()
      view.finish(0, page(), { ...automation(feature), source: 'system', canToggle: true, enabled, configuredEnabled: enabled, editable: true } as ReturnType<typeof automation>)
      await settle()
      assert.doesNotMatch(view.text(), /Disable|Enable/)
      assert.equal(view.nodes().filter(node => node.type === 'nav' && node.props['aria-label'] === 'Workflows').length, 1)
      const sidebar = readFileSync(new URL('./components/AutomationSidebar.vue', import.meta.url), 'utf8')
      assert.doesNotMatch(sidebar, /data-automation-id|useAutomationCatalog|group-toggle/)
      const graph = readFileSync(new URL('./components/WorkflowGraph.vue', import.meta.url), 'utf8')
      assert.match(graph, /emit\('toggle', data.definition.id, !data.control.enabled\)/)
      assert.doesNotMatch(sidebar, /job.source !== 'system'/)
    })
  }
}
test('disabled topic organization prevents dashboard dispatch and offers stable feature settings', () => {
  const source = readFileSync(new URL('./components/ProjectWorkbench.vue', import.meta.url), 'utf8')
  assert.match(source, /if \(organizationDisabled.value \|\| organizationBusy.value \|\| !canWrite.value\) return/)
  assert.equal((source.match(/:disabled="organizationBusy \|\| organizationDisabled"/g) ?? []).length, 2)
  assert.match(source, /automationChatLocation\(projectId, 'system:work-organizer'\)/)
})


test('enable failures preserve bounded known validation reasons instead of claiming inventory failed', async () => {
  const request: typeof fetch = async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/projects/a/api/automations/default%3Awork-dispatch-v1')
    assert.equal(init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(init?.body)), { enabled: true })
    return Response.json({ error: 'invalid_work_dispatch_configuration', message: 'Error: Select a registered repository Workspace first.' }, { status: 400 })
  }
  await assert.rejects(setAutomationEnabled(base, 'default:work-dispatch-v1', true, signal(), request), /Workflow could not be updated: Select a registered repository Workspace first\./)
  for (const [status, value] of [
    [400, { error: 'unknown', message: 'private upstream diagnostic' }],
    [500, { error: 'invalid_work_dispatch_configuration', message: 'private upstream diagnostic' }],
    [400, { error: 'invalid_work_dispatch_configuration', message: '<script>bad</script>' }],
    [400, { error: 'invalid_work_dispatch_configuration', message: 'bad\u0000reason' }],
    [400, { error: 'invalid_work_dispatch_configuration', message: 'x'.repeat(513) }],
    [400, { error: 'invalid_work_dispatch_configuration', message: 'reason', extra: 'x'.repeat(4096) }],
    [400, { error: 'invalid_work_dispatch_configuration', message: {} }],
  ] as const) {
    await assert.rejects(setAutomationEnabled(base, 'work', true, signal(), async () => Response.json(value, { status })), /^AutomationRequestError: Workflow could not be updated\. Check Main and retry\.$/)
  }
  for (const status of [401, 403]) await assert.rejects(setAutomationEnabled(base, 'work', true, signal(), async () => Response.json({}, { status })), /denied/)
  for (const body of ['<html>proxy failure</html>', '{invalid']) {
    await assert.rejects(setAutomationEnabled(base, 'work', true, signal(), async () => new Response(body, { status: 400, headers: { 'content-type': 'application/json' } })), /Workflow could not be updated\. Check Main/)
  }
  await assert.rejects(setAutomationEnabled(base, 'work', true, signal(), async () => { throw new TypeError('network') }), /Workflow could not be updated\. Check Main/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(setAutomationEnabled(base, 'work', true, controller.signal, request), { name: 'AbortError' })
})
