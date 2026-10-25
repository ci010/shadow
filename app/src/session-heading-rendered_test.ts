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
    sequence: 1, changedBy: 'human', changedAt: '2026-09-19T01:00:00.000Z', change: 'goal',
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
        if (id === './FoldersSidebar.vue') return { default: load(id.slice(2)) }
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

test('rendered heading separates Session identity from legacy work definitions', async t => {
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture/projects/a/', sessionId: 'web:chat-admin',
    name: 'Old name', projectName: 'Alpha', physicalId: null, revision: 0, active: false })
  assert.match(view.text(), /Alpha \/ Old name/)
  assert.doesNotMatch(view.text(), /independent conversations/)
  view.state.sessionId = 'web:chat-topic'
  view.state.name = 'Release discussion'
  view.state.topic = { title: 'Desktop release', goal: 'Ship installer', scope: 'Windows only', nonGoals: 'Linux' }
  await nextTick()
  assert.match(view.text(), /Alpha \/ Release discussion/)
  assert.doesNotMatch(view.text(), /Ship installer|Windows only|Out of scope/)
})
