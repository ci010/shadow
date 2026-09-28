import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

interface ElementNode {
  tag: string
  text: string
  props: Record<string, unknown>
  children: ElementNode[]
  style: Record<string, string>
  parent?: ElementNode
}
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [], style: {} })
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

test('rendered chat task status stays absent for ordinary conversation, refreshes on facts and releases hidden reads', async t => {
  const requests: Array<{ url: string; signal: AbortSignal; finish: (data: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: String(url), signal: init.signal!, finish: (data, status = 200) => resolve(Response.json(data, { status })) })
  }))
  const opened: string[] = []
  const view = mount(t, 'SessionWorkStatus.vue', { apiBase: 'http://fixture/projects/a', sessionId: 'web:one',
    active: true, revision: 0, onOpen: (key: string) => opened.push(key) })
  const read = async () => { await new Promise(resolve => setTimeout(resolve, 70)); await settle() }
  await read()
  assert.equal(requests[0].url, 'http://fixture/projects/a/api/sessions/web%3Aone/work?history=0')
  requests[0].finish({ records: [], effects: [] }); await settle()
  assert.equal(view.nodes().filter(node => node.tag === 'button').length, 0)
  view.state.revision = 1; await settle(); await read()
  requests[1].finish({ records: [{
    key: 'topic:web:one', subject: { kind: 'topic', sessionId: 'web:one' }, revision: 1,
    definition: { objective: 'Current assignment', acceptance: [], boundaries: [], evidence: [] },
    origin: 'human', reason: 'Assigned', paused: false, authority: { manager: 'web:one', executor: 'web:one', active: true }, history: [],
  }], effects: [] }); await settle()
  assert.match(view.text(), /Current assignment/)
  await view.button().click(); assert.deepEqual(opened, ['topic:web:one'])
  view.state.revision = 2; await settle(); await read()
  requests[2].finish({}, 503); await settle()
  assert.match(view.text(), /Task status unavailable/)
  view.state.revision = 3; await settle(); await read()
  view.state.active = false; await settle()
  assert.equal(requests[3].signal.aborted, true)
  view.state.revision = 4; await settle(); await read()
  assert.equal(requests.length, 4)
})

function mount(t: TestContext, filename: string, props: Record<string, unknown>) {
  const popover = defineComponent({
    setup: (_, { slots }) => () => h('div', [slots.trigger?.(), slots.default?.({ triggerProps: {} })]),
  })
  function load(filename: string): Component {
    const url = new URL(`./components/${filename}`, import.meta.url)
    const { descriptor } = parse(readFileSync(url, 'utf8'))
    const source = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
    const module = { exports: {} as { default: Component } }
    const require = createRequire(url)
    new Function('require', 'module', 'exports', outputText)(
      (id: string) => {
        if (id === 'vue' && ['ProjectGroup.vue', 'FoldersSidebar.vue'].includes(filename)) {
          return { ...Vue, onMounted() {}, onActivated() {}, onUnmounted() {} }
        }
        if (id === './FoldersSidebar.vue' || id === './ProjectCoordinator.vue') return { default: load(id.slice(2)) }
        return id.endsWith('.vue') ? { default: popover } : require(id)
      }, module, module.exports,
    )
    return module.exports.default
  }
  const component = load(filename)
  const renderer = createRenderer<ElementNode, ElementNode>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      if (index === -1) parent.children.push(node)
      else parent.children.splice(index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
    querySelector: () => element('body'),
  })
  const root = element('root')
  const state = reactive(props)
  const app = renderer.createApp(defineComponent({ setup: () => () => h(component, state) }))
  app.component('RouterLink', defineComponent({ setup: (_, { slots }) => () => h('a', slots.default?.()) }))
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = (): ElementNode[] => {
    const visit = (node: ElementNode): ElementNode[] => [node, ...node.children.flatMap(visit)]
    return visit(root)
  }
  return { state, nodes, unmount: () => app.unmount(),
    text: () => nodes().filter(node => node.tag !== '#comment').map(node => node.text).join(' '),
    button: () => {
      const button = nodes().find(node => node.tag === 'button')!
      return { props: button.props, click: () => (button.props.onClick as () => Promise<void>)() }
    },
  }
}

function coordinator(t: TestContext) {
  const requests: Array<{ url: string; init: RequestInit; finish: (value?: unknown, status?: number) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ url: String(url), init, finish: (value = { projectId: 'a', sessionId: 'web:orchestrator', chatId: 'orchestrator' }, status = 200) =>
      resolve(Response.json(value, { status })) })
  }))
  const opened: string[] = []
  const openings: string[] = []
  const view = mount(t, 'ProjectCoordinator.vue', {
    apiBase: 'http://fixture', projectId: 'a', projectName: 'Alpha', selected: false, navigationKey: '/projects/a/chat/topic',
    onOpen: (id: string) => opened.push(id),
    onOpening: () => openings.push('opening'),
  })
  return { ...view, requests, opened, openings }
}

test('rendered project name opens coordination lazily, prevents duplicate ensures and reports selection accessibly', async t => {
  const view = coordinator(t)
  assert.equal(view.requests.length, 0, 'Rendering the sidebar never creates a coordinator or sends a model turn')
  assert.match(view.text(), /Alpha/)
  assert.doesNotMatch(view.text(), /Project coordination/)
  assert.equal(view.button().props['aria-label'], 'Open Project coordination in Alpha')
  const entry = view.nodes().find(node => node.tag === 'button')!
  const label = entry.children.find(node => node.tag === 'span')!
  const originalText = view.text()
  const first = view.button().click()
  await view.button().click()
  await nextTick()
  assert.equal(view.requests.length, 1)
  assert.equal(view.button().props['aria-disabled'], true)
  assert.equal(view.button().props['aria-busy'], true)
  assert.equal(view.button().props.disabled, undefined, 'Keep the button focusable while the request guard prevents repeat activation')
  assert.equal(view.nodes().find(node => node.tag === 'button'), entry)
  assert.equal(entry.children.find(node => node.tag === 'span'), label, 'Pending navigation must retain the project name')
  assert.equal(view.text(), originalText, 'Pending navigation must not flash a loading label')
  assert.equal(view.requests[0]!.url, 'http://fixture/projects/a/api/orchestrator')
  assert.equal(view.requests[0]!.init.body, '{}')
  view.requests[0]!.finish()
  await first
  await settle()
  assert.deepEqual(view.opened, ['web:orchestrator'])
  view.state.selected = true
  await nextTick()
  assert.equal(view.button().props['aria-current'], 'page')
  assert.equal(view.button().props['aria-disabled'], false)
  assert.equal(view.text(), originalText)
  const selectedText = view.text()
  for (let i = 0; i < 3; i++) {
    const click = view.button().click()
    await nextTick()
    assert.equal(view.requests.length, 1, 'Selecting the current coordinator must not ensure it again')
    assert.equal(view.opened.length, 1, 'Selecting the current coordinator must not navigate again')
    assert.equal(view.openings.length, 1, 'Selecting the current coordinator must not reset navigation state')
    assert.equal(view.button().props['aria-busy'], false)
    assert.equal(view.text(), selectedText, 'Selected item must not flash a loading label or icon')
    await click
  }
})

test('project header arrow only toggles children while its name opens coordination even when collapsed', async t => {
  const requests: Array<{ finish: () => void }> = []
  t.mock.method(globalThis, 'fetch', () => new Promise<Response>(resolve => {
    requests.push({ finish: () => resolve(Response.json({ projectId: 'a', sessionId: 'web:orchestrator', chatId: 'orchestrator' })) })
  }))
  const selected: string[] = []
  const view = mount(t, 'ProjectGroup.vue', {
    apiBase: 'http://fixture', project: { id: 'a', name: 'Alpha', createdAt: '' },
    selectedProjectId: 'a', selectedSessionId: 'web:topic', navigationKey: '/projects/a/chat/topic',
    remoteFolders: false, onSelect: (id: string) => selected.push(id),
  })
  const toggle = view.nodes().find(node => node.props['aria-label'] === 'Collapse project Alpha')!
  const name = view.nodes().find(node => node.props['aria-label'] === 'Open Project coordination in Alpha')!
  assert.ok(toggle)
  assert.ok(name)
  assert.equal(toggle.parent?.tag, 'header')
  assert.equal(name.parent?.parent?.tag, 'h2', 'Coordination belongs in the project heading, not a child item')
  assert.equal(view.nodes().filter(node => node.props['aria-label'] === 'Open Project coordination in Alpha').length, 1)
  assert.doesNotMatch(view.text(), /Project coordination/)
  const navigation = view.nodes().find(node => node.props.id === toggle.props['aria-controls'])!
  const click = (node: ElementNode) => (node.props.onClick as () => Promise<void> | void)()
  await click(toggle)
  await nextTick()
  assert.equal(toggle.props['aria-expanded'], false)
  assert.equal(toggle.props['aria-label'], 'Expand project Alpha')
  assert.equal(navigation.style.display, 'none')
  assert.equal(requests.length, 0, 'Disclosure must not create or open a coordination session')
  const open = click(name)
  await nextTick()
  assert.equal(requests.length, 1)
  assert.equal(toggle.props['aria-expanded'], false, 'Opening a project does not expand its children')
  requests[0]!.finish()
  await open
  await settle()
  assert.deepEqual(selected, ['web:orchestrator'])
  view.state.selectedSessionId = 'web:orchestrator'
  await nextTick()
  assert.equal(name.props['aria-current'], 'page')
  await click(toggle)
  await nextTick()
  assert.equal(toggle.props['aria-expanded'], true)
  assert.notEqual(navigation.style.display, 'none')
  assert.deepEqual(selected, ['web:orchestrator'], 'Disclosure does not navigate')
  await click(name)
  assert.equal(requests.length, 1)
  assert.equal(toggle.props['aria-expanded'], true)
})

test('rendered coordinator aborts project/navigation switches and ignores late responses even if transport ignores abort', async t => {
  const view = coordinator(t)
  const first = view.button().click()
  view.state.navigationKey = '/projects/b/chat/other'
  await nextTick()
  assert.equal(view.requests[0]!.init.signal?.aborted, true)
  view.requests[0]!.finish()
  await first
  assert.deepEqual(view.opened, [])
  view.state.projectId = 'b'
  view.state.projectName = 'Beta'
  await nextTick()
  const second = view.button().click()
  assert.equal(view.requests[1]!.url, 'http://fixture/projects/b/api/orchestrator')
  view.requests[1]!.finish({ projectId: 'b', sessionId: 'web:orchestrator', chatId: 'orchestrator' })
  await second
  assert.deepEqual(view.opened, ['web:orchestrator'])
})

test('rendered failures expose retry without navigation, and disposal cancels pending navigation', async t => {
  const view = coordinator(t)
  const first = view.button().click()
  view.requests[0]!.finish({}, 503)
  await first
  await settle()
  assert.equal(view.opened.length, 0)
  assert.ok(view.nodes().some(node => node.props.role === 'alert'))
  assert.match(view.text(), /503.*Retry/s)
  const second = view.button().click()
  await nextTick()
  assert.equal(view.nodes().some(node => node.props.role === 'alert'), false)
  view.unmount()
  assert.equal(view.requests[1]!.init.signal?.aborted, true)
  view.requests[1]!.finish()
  await second
  assert.deepEqual(view.opened, [])
})

test('another Project coordinator click cancels an earlier ensure before either navigation finishes', async t => {
  const view = coordinator(t)
  const pending = view.button().click()
  view.state.pendingProjectId = 'b'
  await nextTick()
  assert.equal(view.requests[0]!.init.signal?.aborted, true)
  view.requests[0]!.finish()
  await pending
  assert.deepEqual(view.opened, [])
  assert.equal(view.button().props['aria-disabled'], false)
})

test('rendered heading separates Session identity from legacy work definitions', async t => {
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture/projects/a/', sessionId: 'web:orchestrator',
    name: 'Old name', projectName: 'Alpha', physicalId: null, revision: 0, active: false })
  assert.match(view.text(), /Alpha \/ Project coordination/)
  assert.match(view.text(), /independent conversations/)
  view.state.sessionId = 'web:chat-topic'
  view.state.name = 'Release discussion'
  view.state.topic = { title: 'Desktop release', goal: 'Ship installer', scope: 'Windows only', nonGoals: 'Linux' }
  await nextTick()
  assert.match(view.text(), /Alpha \/ Release discussion/)
  assert.doesNotMatch(view.text(), /Ship installer|Windows only|Out of scope/)
})
