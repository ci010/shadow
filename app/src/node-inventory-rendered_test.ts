import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, nextTick, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { t as translate, formatDateTime, setLocalePreference } from './i18n.ts'
import type { NodeInventoryEntry } from './node-inventory.ts'

interface Element {
  tag: string
  text: string
  props: Record<string, unknown>
  children: Element[]
  parent?: Element
}
const element = (tag: string, text = ''): Element => ({ tag, text, props: {}, children: [] })
const text = (node: Element): string => node.tag === '#comment' ? '' : [node.text, ...node.children.map(text)].join(' ')
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await nextTick() }

/** Actual Nodes template; nested pairing/setup controls are outside this inventory contract. */
function mount(t: TestContext) {
  const url = new URL('./components/NodesView.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'inventory', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  const nested = defineComponent({ setup: () => () => null })
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('.vue') ? { default: nested }
      : id.endsWith('/i18n.ts') ? { t: translate, formatDateTime } : require(id), module, module.exports,
  )
  const documentBefore = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { hidden: false, addEventListener() {}, removeEventListener() {} } })
  const renderer = createRenderer<Element, Element>({
    createElement: element, createText: text => element('#text', text), createComment: text => element('#comment', text),
    insert(node, parent, anchor) {
      if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1)
      node.parent = parent
      const index = anchor ? parent.children.indexOf(anchor) : -1
      parent.children.splice(index < 0 ? parent.children.length : index, 0, node)
    },
    remove(node) { if (node.parent) node.parent.children.splice(node.parent.children.indexOf(node), 1) },
    setText: (node, text) => { node.text = text },
    setElementText: (node, text) => { node.text = text; node.children = [] },
    patchProp: (node, key, _previous, value) => { node.props[key] = value },
    parentNode: node => node.parent ?? null,
    nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
  })
  const root = element('root')
  const app = renderer.createApp(module.exports.default, { apiBase: 'http://fixture/projects/a/' })
  app.mount(root)
  t.after(() => {
    app.unmount()
    if (documentBefore) Object.defineProperty(globalThis, 'document', documentBefore)
    else Reflect.deleteProperty(globalThis, 'document')
    setLocalePreference('en')
  })
  const nodes = (node: Element = root): Element[] => [node, ...node.children.flatMap(child => nodes(child))]
  return { nodes, text: () => text(root), refresh: async () => {
    const button = nodes().find(node => node.tag === 'button' && text(node).includes('Refresh'))
    assert.ok(button)
    assert.equal(button.props.disabled, false)
    assert.ok(typeof button.props.onClick === 'function')
    await button.props.onClick()
    await flush()
  } }
}

test('rendered Nodes shows directory support inline without Resource or Capability layers or permission claims', async t => {
  let nodes: NodeInventoryEntry[] = [{
    nodeId: 'child', displayName: 'Resource device', role: 'child', connection: 'connected', executionProtocol: 'compatible',
    workdirs: [{ version: 2 as const, nodeId: 'child', workdirId: 'repo-resource', displayName: 'Source directory', displayPath: '/display/source', online: true, support: { operations: ['filesystem.read','filesystem.write'], shell: { shells: ['sh'], maxInputBytes: 4096 } } }],
    support: { operations: ['workdir.session.allocate'] },
  }]
  let requests = 0
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    assert.equal(String(input), 'http://fixture/nodes/v1')
    assert.equal(init?.method, undefined, 'Viewing support must not authorize a Project or allocate a folder')
    requests++
    return Response.json({ version: 1, nodes })
  })
  const view = mount(t)
  await flush()
  const resourceSection = view.nodes().find(node => node.tag === 'details' && text(node).includes('Directories'))
  assert.ok(resourceSection)
  assert.match(text(resourceSection), /Source directory.*repo-resource.*\/display\/source/)
  assert.match(text(resourceSection), /Supported operations.*filesystem.read.*filesystem.write/)
  assert.match(text(resourceSection), /Available shells.*sh/)
  assert.doesNotMatch(text(resourceSection), /Resource scope|Capability|Execution conditions|Managed allocation/)
  assert.match(view.text(), /Device operations.*workdir.session.allocate/)
  assert.match(view.text(), /Support is not project permission/)
  assert.equal(requests, 1)
  nodes = nodes.map(node => ({ ...node, executionProtocol: 'upgrade-required' }))
  await view.refresh()
  assert.match(view.text(), /Update Main and the device/)
  const rows = view.nodes().filter(node => node.props.class === 'capability-row')
  assert.equal(rows.length, 1)
  assert.ok(rows.every(row => text(row).includes('Unavailable')))
  setLocalePreference('zh-CN')
  await nextTick()
  assert.match(view.text(), /目录/)
  assert.match(view.text(), /不代表项目权限/)
  assert.match(view.text(), /filesystem.read/)
  assert.match(view.text(), /\/display\/source/)
  assert.match(view.text(), /请更新 Main 和此设备后重试/)
})
