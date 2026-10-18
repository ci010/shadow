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
const settle = () => new Promise(resolve => setTimeout(resolve, 10))
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
  ]) await assert.rejects(fetchAutomations(base, signal(), response(value)), /invalid automation data/)
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
  }]) await assert.rejects(fetchAutomationRuns(base, 'learning:reflector', 0, signal(), response(page([{ ...run(), learning }]))), /invalid automation data/)
  assert.equal((await fetchAutomationRuns(base, 'learning:reflector', 0, signal(), response(page()))).runs[0].learning, undefined)
})

test('learning conversations show partial outcomes and keep legacy completion unverified', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([{ ...run(), learning: {
    status: 'partial', summary: 'One decision saved; remaining evidence unread.', artifacts: 1, events: 1, evaluated: 0,
  } }, run('legacy')]), { ...automation(), source: 'learning' })
  await settle()
  assert.match(view.text(), /Partial/)
  assert.match(view.text(), /One decision saved; remaining evidence unread/)
  assert.match(view.text(), /Execution: Completed/)
  assert.match(view.text(), /1 recorded artifact/)
  assert.doesNotMatch(view.text(), /1 verified artifact/)
  view.props.selectedSessionId = run('legacy').sessionId
  await nextTick()
  assert.match(view.text(), /No verified learning receipt/)
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
  ]) await assert.rejects(fetchAutomationRuns(base, 'weekly', 0, signal(), response(value)), /invalid automation data/)
  for (const offset of [-1, NaN, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(fetchAutomationRuns(base, 'weekly', offset, signal(), response(page())), /invalid automation data/)
  }
  await assert.rejects(fetchAutomationRuns(base, '..', 0, signal(), response(page())), /invalid automation data/)
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
    [async () => new Response('{invalid'), /invalid automation data/],
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
  const sidebarProps = reactive({ apiBase: base, active, groups: [], stages: {} })
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
  // These catalog/action tests exercise the expanded contents; the real-renderer
  // sidebar test separately verifies the default-collapsed disclosure behavior.
  const expandSidebar = (parent: TreeNode): void => {
    if (parent.props.class === 'automations-heading') (parent.props.onClick as (() => void))()
    else for (const child of parent.children) expandSidebar(child)
  }
  if (withSidebar) expandSidebar(root)
  let mounted = true
  const unmount = () => { if (mounted) { app.unmount(); mounted = false } }
  t.after(unmount)
  const state = () => {
    assert.ok(instance)
    const setup = Reflect.get(instance.$, 'setupState')
    return new Proxy(setup, { get(target, key) {
      if (key === 'runs') return target.history.runs
      if (key === 'error') return target.error || target.historyError
      return Reflect.get(target, key)
    } })
  }
  const finish = (from = 0, runs = page(), item = automation()) => {
    requests[from].finish({ automations: [item] })
    requests[from + 1].finish(runs)
  }
  const invalidate = () => subscriptions.at(-1)!.observer.reset('subscription')
  const setVisible = (value: boolean) => { visibility.visibilityState = value ? 'visible' : 'hidden'; visibility.dispatchEvent(new Event('visibilitychange')) }
  const nodes = (parent = root): TreeNode[] => [parent, ...parent.children.flatMap(child => nodes(child))]
  const text = () => nodes().map(node => node.text).join(' ')
  return { props, sidebarProps, requests, subscriptions, state, invalidate, unmount, finish, intervals, setVisible, opens, nodes, text }
}

test('concurrent sidebar and detail share one catalog request, subscription and polling timer', async t => {
  const view = mount(t, true, true)
  await settle()
  assert.equal(view.requests.filter(request => request.url.pathname.endsWith('/api/automations')).length, 1)
  assert.equal(view.requests.length, 2, 'One catalog and one run-page read, rather than two catalog reads and a page')
  assert.equal(view.subscriptions.length, 1)
  assert.equal(view.intervals.size, 1)
  view.finish()
  await settle()
  view.props.active = false
  await nextTick()
  assert.equal(view.subscriptions[0].closed, false, 'Hiding detail must not release the sidebar resource')
  view.invalidate()
  await settle()
  assert.equal(view.requests.length, 3, 'Sidebar-only invalidation does not fetch hidden run pages')
  view.requests[2].finish({ automations: [automation()] })
  await settle()
  view.props.active = true
  await nextTick()
  await settle()
  assert.equal(view.requests.length, 4, 'Reactivating detail reuses the loaded catalog')
  view.requests[3].finish(page())
  await settle()
  view.props.apiBase = 'http://fixture/projects/b'
  await nextTick()
  await settle()
  assert.equal(view.subscriptions.length, 2)
  assert.equal(view.subscriptions[0].closed, false, 'Project A sidebar still owns its subscription')
  assert.equal(view.state().automation, null)
  view.finish(4, page([run('b')]), { ...automation(), name: 'B review' })
  await settle()
  assert.equal(view.state().automation.name, 'B review')
  view.sidebarProps.active = false
  await nextTick()
  assert.equal(view.subscriptions[0].closed, true)
  assert.equal(view.subscriptions[1].closed, false)
  view.unmount()
  assert.equal(view.intervals.size, 0)
  assert.ok(view.subscriptions.every(subscription => subscription.closed))
})

test('empty automation sidebar disappears after loading without hiding errors', async t => {
  const view = mount(t, true, true)
  await settle()
  assert.ok(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'))
  assert.match(view.text(), /Loading automations/)
  view.requests[0].finish({ automations: [] })
  view.requests[1].finish(page([]))
  await settle()
  assert.equal(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'), false)
  assert.doesNotMatch(view.text(), /Fresh-context tasks appear here/)
  view.invalidate()
  await settle()
  assert.equal(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'), false,
    'Refreshing an already loaded empty catalog must not flash the section')
  assert.doesNotMatch(view.text(), /Loading automations/)
  const refresh = view.requests.find((request, index) => index > 1 && request.url.pathname.endsWith('/api/automations'))
  assert.ok(refresh)
  refresh.finish({ error: 'unavailable' }, 503)
  await settle()
  assert.ok(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'))
  assert.ok(view.nodes().some(node => node.type === 'button' && node.props['aria-label'] === 'Retry automations'))
})

test('empty automation sidebar stays hidden while visibility resumes and the catalog refreshes', async t => {
  const view = mount(t, true, true)
  await settle()
  view.requests[0].finish({ automations: [] })
  view.requests[1].finish(page([]))
  await settle()
  for (let cycle = 0; cycle < 2; cycle++) {
    view.setVisible(false)
    await nextTick()
    assert.equal(view.intervals.size, 0)
    assert.ok(view.subscriptions.every(subscription => subscription.closed))
    view.setVisible(true)
    await nextTick()
    await settle()
    assert.equal(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'), false)
    assert.doesNotMatch(view.text(), /Loading automations/)
  }
  assert.ok(view.requests.slice(2, 4).every(request => request.signal.aborted))
  view.requests[2].finish({ automations: [automation()] })
  view.requests[4].finish({ automations: [] })
  await settle()
  assert.equal(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'), false)
})

test('automation rows survive resumed refreshes and failures but never cross project boundaries', async t => {
  const view = mount(t, true, true)
  await settle()
  view.finish()
  await settle()
  const entry = () => view.nodes().find(node => node.props['data-automation-id'] === automation().id)
  const original = entry()
  assert.ok(original)
  view.setVisible(false)
  await nextTick()
  view.setVisible(true)
  await nextTick()
  await settle()
  assert.equal(entry(), original, 'The existing row must stay mounted during a resumed fetch')
  assert.doesNotMatch(view.text(), /Loading automations/)
  view.requests[2].finish({}, 503)
  view.requests[3].finish(page())
  await settle()
  assert.equal(entry(), original)
  const retry = view.nodes().find(node => node.props['aria-label'] === 'Retry automations')
  assert.ok(retry)
  ;(retry.props.onClick as () => void)()
  await settle()
  assert.equal(entry(), original)
  view.requests[4].finish({ automations: [{ ...automation(), name: 'Updated review' }] })
  view.requests[5].finish(page())
  await settle()
  assert.equal(entry(), original)
  assert.match(view.text(), /Updated review/)
  view.setVisible(false)
  await nextTick()
  view.sidebarProps.apiBase = 'http://fixture/projects/b'
  view.props.apiBase = view.sidebarProps.apiBase
  await nextTick()
  assert.equal(entry(), undefined)
  assert.doesNotMatch(view.text(), /Updated review/)
  view.setVisible(true)
  await nextTick()
  assert.match(view.text(), /Loading automations/)
  assert.equal(entry(), undefined)
  await settle()
  view.finish(6)
  await settle()
  assert.ok(entry())
  view.invalidate()
  await settle()
  view.requests[8].finish({ automations: [] })
  view.requests[9].finish(page([]))
  await settle()
  assert.equal(entry(), undefined, 'A successful empty response replaces retained rows')
  assert.equal(view.nodes().some(node => node.type === 'section' && node.props['aria-label'] === 'Automations'), false)
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
  assert.match(view.state().error, /invalid automation data/)
})

test('collapsed conversation metadata explains learning checks without adding a configuration tab', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([{ ...run(), status: 'failed', title: 'Saved conversation title' }]), {
    ...automation(), source: 'learning', enabled: false,
  })
  await settle()
  assert.match(view.text(), /Dispatch is disabled/)
  assert.match(view.text(), /Failed/)
  assert.match(view.text(), /Review recent work/)
  assert.equal(view.props.selectedSessionId, run().sessionId)
  assert.deepEqual(view.opens, [])
  const details = view.nodes().find(node => node.type === 'details' && node.props.class === 'automation-info')
  assert.ok(details)
  assert.ok(!details.props.open)
  assert.equal(view.nodes().some(node => node.props.role === 'tab' && view.nodes(node).some(child => child.text.includes('Configuration'))), false)
  assert.match(view.text(), /Check frequency/)
  assert.match(view.text(), /activity-gated/)
  assert.match(view.text(), /each dispatch starts a separate conversation/)
  assert.match(view.text(), /Review recent work/)
  assert.equal(view.requests.length, 2, 'Conversation metadata reuses the same catalog and history')
})

test('an automation with no runs keeps its read-only details without creating a draft', async t => {
  const view = mount(t)
  await settle()
  view.finish(0, page([]))
  await settle()
  assert.equal(view.props.selectedSessionId, '')
  assert.deepEqual(view.opens, [])
  assert.match(view.text(), /No saved runs yet/)
  assert.match(view.text(), /Review recent work/)
  assert.ok(view.nodes().some(node => node.type === 'details' && node.props.class === 'automation-info'))
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

test('sidebar preference actions live only in the popup and work under master suppression', async t => {
  const view = mount(t, true, true)
  await settle()
  view.finish(0, page(), { ...automation(), enabled: false, configuredEnabled: true, editable: true, disabledByGlobal: true })
  await settle()
  const sidebarNodes = () => view.nodes(view.nodes().find(node => node.type === 'section' && node.props['aria-label'] === 'Automations')!)
  const action = () => sidebarNodes().find(node => node.props.class === 'automation-action')
  assert.equal(sidebarNodes().some(node => node.type === 'input'), false)
  assert.equal(action(), undefined, 'No inline enable/disable control')
  assert.doesNotMatch(view.text(), /Paused by global switch/)
  const hover = sidebarNodes().find(node => node.props.class === 'hover-info-test')!
  ;(hover.props.onPointerenter as () => void)()
  await nextTick()
  assert.equal(action()!.text, 'Disable', 'Action uses configured rather than effective state')
  assert.equal(action()!.props.disabled, false)
  ;(action()!.props.onClick as () => void)()
  await nextTick()
  assert.equal(action()!.props.disabled, true)
  assert.equal(action()!.props['aria-busy'], true)
  const patch = view.requests.at(-1)!
  assert.equal(patch.init.method, 'PATCH')
  assert.deepEqual(JSON.parse(String(patch.init.body)), { enabled: false })
  ;(action()!.props.onClick as () => void)()
  assert.equal(view.requests.at(-1), patch, 'Busy actions cannot submit duplicate updates')
  patch.finish({ automation: { id: automation().id } })
  await settle()
  view.requests.findLast(request => request.url.pathname.endsWith('/api/automations'))!.finish({ automations: [{ ...automation(), enabled: false, configuredEnabled: false, editable: true, disabledByGlobal: true }] })
  await settle()
  assert.equal(action()!.text, 'Enable')
  ;(action()!.props.onClick as () => void)()
  await nextTick()
  assert.deepEqual(JSON.parse(String(view.requests.at(-1)!.init.body)), { enabled: true })
  view.requests.at(-1)!.finish({}, 503)
  await settle()
  assert.equal(action()!.props.disabled, false)
  assert.ok(sidebarNodes().some(node => node.props.role === 'alert'))
  view.requests.findLast(request => request.url.pathname.endsWith('/api/automations'))!.finish({ automations: [{ ...automation(), enabled: false }] })
  await settle()
  assert.equal(action(), undefined, 'Historical entries have no controls in the popup')
  assert.doesNotMatch(view.text(), /Paused by global switch/)
  assert.equal(sidebarNodes().some(node => node.type === 'input'), false)
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
  assert.match(view.text(), /Execution history/)
  assert.match(view.text(), /1\/3 Coverage/)
  assert.match(view.text(), /Organization ended without finishing/)
  assert.match(view.text(), /Partial/)
  assert.match(view.text(), /Inactive/)
  assert.match(view.text(), /Enable/)
  assert.match(view.text(), /Controls this automation feature, not the saved run/)
  assert.equal(view.state().history.runs.length, 2)
  view.state().scope = 'delta'
  await nextTick()
  assert.equal(view.state().filteredRuns.length, 1)
  assert.equal(view.state().filteredRuns[0].scope, 'delta')
  const disclosures = view.nodes().filter(node => node.type === 'details')
  assert(disclosures.length > 0)
  assert(disclosures.every(node => !node.props.open))
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
    test(`system feature ${feature} exposes ${enabled ? 'disable' : 'enable'} in popup`, async t => {
      const view = mount(t, true, true)
      view.props.automationId = feature
      await settle()
      view.finish(0, page(), { ...automation(feature), source: 'system', canToggle: true, enabled, configuredEnabled: enabled, editable: true } as ReturnType<typeof automation>)
      await settle()
      assert.match(view.text(), enabled ? /Disable/ : /Enable/)
      const sidebar = readFileSync(new URL('./components/AutomationSidebar.vue', import.meta.url), 'utf8')
      assert.match(sidebar, /toggle\(job.id, job.toggleId \?\? job.id, !preference\(job\)\)/)
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
