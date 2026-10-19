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
  assert.doesNotMatch(view.text(), /Subagents/)
  assert.match(view.text(), /400K limit/)
  assert.match(view.text(), /300K remaining/)
  assert.match(view.text(), /60%.*240K/)
  assert.match(view.text(), /90%.*360K/)
  assert.doesNotMatch(view.text(), /Total includes this conversation|Partial usage:|Auto handoff|separate token counts are not reported|Last reported context/)
  const bar = view.nodes().find(node => node.props.role === 'img')!
  assert.equal(bar.props['aria-label'], '25% context used')
  assert.equal(bar.children[0].props.style && (bar.children[0].props.style as Record<string, string>).width, '25%')
  context = { ...context, usedTokens: null, handoff: { ...context.handoff, enabled: false } }
  view.state.revision = 1
  await settle(); await settle()
  assert.match(view.text(), /Remaining unknown/)
  assert.doesNotMatch(view.text(), /Auto handoff/)
  assert.doesNotMatch(view.text(), /300K remaining/)
  assert.equal(view.nodes().find(node => node.props.role === 'img')!.props['aria-label'], 'Context usage not reported')
})

test('heading displays cache tokens and independently weighted rates for total and subagents', async t => {
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    sessionId: 'web:cache', name: 'Cache fixture', workdir: { kind: 'local', displayPath: '/fixture' },
    usage: { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedTokens: 750 },
    subagentUsage: { promptTokens: 200, completionTokens: 20, totalTokens: 220, cachedTokens: 0 },
    usageScope: 'session', context: { usedTokens: null, windowTokens: null },
  }))
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture', sessionId: 'web:cache',
    name: 'Cache fixture', physicalId: null, revision: 0, active: true })
  await settle()
  assert.match(view.text(), /input\s+750\s+\(75%\)\s+cache\s+100\s+output/)
  assert.match(view.text(), /input\s+0\s+\(0%\)\s+cache\s+20\s+output/)
  const cacheRows = view.nodes().filter(node => node.tag === 'span' && node.props.title === 'Cache-read tokens / input tokens')
  assert.equal(cacheRows.length, 2)
  assert.ok(cacheRows.every(node => node.children.some(child => child.props['aria-label'] === 'Cache rate')))
})

test('heading distinguishes partial cache reports, explicit zero and unreported calls', async t => {
  let usage = { promptTokens: 1000, completionTokens: 100, totalTokens: 1100, cachedTokens: 400, cacheReportedPromptTokens: 500 }
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    sessionId: 'web:partial', name: 'Partial cache', workdir: { kind: 'local', displayPath: '/fixture' },
    usage, subagentUsage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
    usageIncomplete: true, usageScope: 'session', context: { usedTokens: null, windowTokens: null },
  }))
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture', sessionId: 'web:partial',
    name: 'Partial cache', physicalId: null, revision: 0, active: true })
  await settle()
  assert.match(view.text(), /400\s+\(80%\)\s+cache/)
  assert.match(view.text(), /Partial cache report: 500 \/ 1K input tokens. Rate covers reported inputs only./)
  assert.match(view.text(), /Token totals are partial; some calls have no reported usage./)
  assert.match(view.text(), /Not reported\s+\(Not reported\)\s+cache/)
  usage = { ...usage, cachedTokens: 0 }
  view.state.revision = 1
  await settle(); await settle()
  assert.match(view.text(), /0\s+\(0%\)\s+cache/)
  assert.match(view.text(), /Partial cache report:/)
})

test('heading displays estimated currency and AI credits without merging units', async t => {
  let incomplete = true
  let costs: Array<{ amount: number; currency: string }> | undefined = [{ amount: .00012, currency: 'USD' }, { amount: 1.25, currency: 'AI_CREDITS' }]
  t.mock.method(globalThis, 'fetch', async () => Response.json({
    sessionId: 'web:cost', name: 'Cost fixture', workdir: { kind: 'local', displayPath: '/fixture' },
    usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110,
      costs, costIncomplete: incomplete },
    usageScope: 'session', context: { usedTokens: null, windowTokens: null },
  }))
  const view = mount(t, 'SessionHeading.vue', { apiBase: 'http://fixture', sessionId: 'web:cost',
    name: 'Fixture', physicalId: null, revision: 0, active: true })
  await settle()
  assert.match(view.text(), /Known cost subtotal \(incomplete\): USD 0\.00012/)
  assert.match(view.text(), /Known cost subtotal \(incomplete\): 1\.25 AI credits/)
  assert.match(view.text(), /Cost estimate incomplete/)
  assert.ok(view.nodes().some(node => node.props.title === 'Estimated cost, not a bill. Plan allowances and discounts may differ.'))
  assert.doesNotMatch(view.text(), /Estimated cost:/)
  incomplete = false
  view.state.revision = 1
  await settle(); await settle()
  assert.match(view.text(), /Estimated cost: USD 0\.00012/)
  assert.doesNotMatch(view.text(), /Known cost subtotal/)
  costs = undefined
  incomplete = true
  view.state.revision = 2
  await settle(); await settle()
  assert.match(view.text(), /Cost could not be estimated/)
  assert.doesNotMatch(view.text(), /Cost estimate incomplete|Estimated cost:|Known cost subtotal/)

})
