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
  style: Record<string, string>
  parent?: ElementNode
}
const element = (tag: string, text = ''): ElementNode => ({ tag, text, props: {}, children: [], style: {} })

test('shared session item renders truthful metadata and updates project context', async t => {
  const session = { sessionId: 'web:one', label: 'Fallback', title: 'Human title', folderId: 'folder-a', lastActivityAt: '2026-11-04T01:00:00Z' }
  const title = mount(t, 'SessionListItem.vue', { session, part: 'title' })
  assert.match(title.text(), /Human title/)
  title.state.session = { ...session, title: undefined }; await nextTick()
  assert.match(title.text(), /Fallback/)
  const view = mount(t, 'SessionListItem.vue', { session, part: 'metadata', projectLabel: 'Alpha', metadata: { folder: 'shadow', folderTone: 2, time: '2m', absoluteTime: 'absolute' } })
  assert.match(view.text(), /Alpha.*shadow.*2m/)
  assert.equal(view.nodes().find(node => node.tag === 'time')?.props.datetime, session.lastActivityAt)
  assert.equal(view.nodes().find(node => node.props['data-folder-tone'] === 2)?.text, 'shadow')
  view.state.projectLabel = undefined; await nextTick()
  assert.doesNotMatch(view.text(), /Alpha/)
  assert.match(view.text(), /shadow.*2m/)
})

test('shared icon honors completion, foreground, background and delegated live facts', async t => {
  const view = mount(t, 'SessionListItem.vue', { session: { sessionId: 'web:one', label: 'One', completed: true }, part: 'icon' })
  const has = (value: string) => view.nodes().some(node => String(node.props.class).includes(value))
  assert.ok(has('i-lucide-circle-check'))
  view.state.stage = 'waiting'; await nextTick()
  assert.ok(has('i-lucide-message-circle-question'))
  view.state.stage = undefined
  view.state.session = { sessionId: 'web:one', label: 'One', hasBackgroundTasks: true }; await nextTick()
  assert.ok(has('i-lucide-terminal'))
  view.state.subagents = { running: 1, waiting: 0, pending: 0 }; await nextTick()
  assert.ok(has('i-lucide-git-branch'))
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
        if (id === './WorkingWave.vue') return { default: popover }
        return id.endsWith('.vue') ? { default: load(id.slice(2)) } : require(id)
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

