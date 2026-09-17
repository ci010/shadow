import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

interface ElementNode {
  tag: string
  text: string
  props: Record<string, unknown>
  children: ElementNode[]
  parent?: ElementNode
}
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [] })
const settle = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

function mount(t: TestContext, filename: string, props: Record<string, unknown>) {
  const url = new URL(`./components/${filename}`, import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: filename, inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  const popover = defineComponent({
    setup: (_, { slots }) => () => h('div', [slots.trigger?.(), slots.default?.()]),
  })
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('.vue') ? { default: popover } : require(id), module, module.exports,
  )
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
  })
  const root = element('root')
  const state = reactive(props)
  const app = renderer.createApp(defineComponent({ setup: () => () => h(module.exports.default, state) }))
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

test('rendered fixed coordinator opens lazily, prevents duplicate ensures and reports selection accessibly', async t => {
  const view = coordinator(t)
  assert.equal(view.requests.length, 0, 'Rendering the sidebar never creates a coordinator or sends a model turn')
  assert.match(view.text(), /Project coordination/)
  assert.equal(view.button().props['aria-label'], 'Open Project coordination in Alpha')
  const first = view.button().click()
  await view.button().click()
  await nextTick()
  assert.equal(view.requests.length, 1)
  assert.equal(view.button().props.disabled, true)
  assert.match(view.text(), /Opening coordination/)
  assert.equal(view.requests[0]!.url, 'http://fixture/projects/a/api/orchestrator')
  assert.equal(view.requests[0]!.init.body, '{}')
  view.requests[0]!.finish()
  await first
  await settle()
  assert.deepEqual(view.opened, ['web:orchestrator'])
  view.state.selected = true
  await nextTick()
  assert.equal(view.button().props['aria-current'], 'page')
  assert.equal(view.button().props.disabled, false)
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
  assert.equal(view.button().props.disabled, false)
})

test('rendered heading recognizes Project coordination without a folder and exposes topic goal/scope', async t => {
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture/projects/a/', sessionId: 'web:orchestrator',
    name: 'Old name', projectName: 'Alpha', physicalId: null, revision: 0, active: false })
  assert.match(view.text(), /Alpha \/ Project coordination/)
  assert.match(view.text(), /Project-wide · No folder/)
  assert.match(view.text(), /independent conversations/)
  view.state.sessionId = 'web:chat-topic'
  view.state.topic = { title: 'Desktop release', goal: 'Ship installer', scope: 'Windows only', nonGoals: 'Linux' }
  await nextTick()
  assert.match(view.text(), /Alpha \/ Desktop release/)
  assert.match(view.text(), /Ship installer/)
  assert.match(view.text(), /Windows only/)
  assert.match(view.text(), /Out of scope.*Linux/s)
  assert.ok(view.nodes().some(node => node.tag === 'details'))
})
