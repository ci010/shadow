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

test('heading renders accessible capacity, actual low/high thresholds and unknown usage', async t => {
  let context = { usedTokens: 100_000 as number | null, windowTokens: 400_000,
    handoff: { enabled: true, low: .6, high: .9, windowTokens: 400_000 } }
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    sessionId: 'web:one', name: 'Fixture', workdir: { kind: 'local', displayPath: '/fixture' },
    usage: null, usageScope: 'session', context,
  }))
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture', sessionId: 'web:one',
    name: 'Fixture', physicalId: null, revision: 0, active: true })
  await settle()
  assert.match(view.text(), /400K limit/)
  assert.match(view.text(), /300K remaining/)
  assert.match(view.text(), /60%.*240K/)
  assert.match(view.text(), /90%.*360K/)
  assert.match(view.text(), /separate token counts are not reported/)
  const bar = view.nodes().find(node => node.props.role === 'img')!
  assert.equal(bar.props['aria-label'], '25% context used')
  assert.equal(bar.children[0].props.style && (bar.children[0].props.style as Record<string, string>).width, '25%')
  context = { ...context, usedTokens: null, handoff: { ...context.handoff, enabled: false } }
  view.state.revision = 1
  await settle(); await settle()
  assert.match(view.text(), /Remaining unknown/)
  assert.match(view.text(), /Auto handoff disabled/)
  assert.doesNotMatch(view.text(), /300K remaining/)
  assert.equal(view.nodes().find(node => node.props.role === 'img')!.props['aria-label'], 'Context usage not reported')
})
