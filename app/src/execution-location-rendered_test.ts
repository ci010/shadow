import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import { createRenderer, defineComponent, h, nextTick, reactive, type Component } from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import type { ExecutionLocation } from './execution-locations.ts'
import type { FolderRecord } from './folders-client.ts'

interface Element {
  tag: string
  text: string
  props: Record<string, unknown>
  children: Element[]
  parent?: Element
}
const element = (tag: string, text = ''): Element => ({ tag, text, props: {}, children: [] })
const text = (node: Element): string => node.tag === '#comment' ? '' : [node.text, ...node.children.map(text)].join(' ')

function mount(t: TestContext, props: Record<string, unknown>) {
  const url = new URL('./components/ExecutionLocationSelector.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const source = compileScript(descriptor, { id: 'locations', inlineTemplate: true }).content
  const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } })
  const module = { exports: {} as { default: Component } }
  const require = createRequire(url)
  const popover = defineComponent({
    emits: ['opened', 'closed'],
    setup: (_, { emit, slots }) => () => h('div', [
      h('button', { 'aria-label': 'Open locations', onClick: () => emit('opened') }, slots.trigger?.()),
      slots.default?.({ close: () => emit('closed') }),
    ]),
  })
  new Function('require', 'module', 'exports', outputText)(
    (id: string) => id.endsWith('.vue') ? { default: popover } : require(id), module, module.exports,
  )
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
  const app = renderer.createApp(defineComponent({ setup: () => () => h(module.exports.default, props) }))
  app.mount(root)
  t.after(() => app.unmount())
  const nodes = (node: Element = root): Element[] => [node, ...node.children.flatMap(child => nodes(child))]
  const button = (label: string) => {
    const buttons = nodes().filter(node => node.tag === 'button')
    const result = buttons.find(node => node.props['aria-label'] === label) ?? buttons.find(node => !node.props['aria-label'] && text(node).includes(label))
    assert.ok(result, `Missing button: ${label}`)
    return result
  }
  const click = async (label: string) => {
    const target = button(label)
    assert.notEqual(target.props.disabled, true)
    const handler = target.props.onClick
    assert.ok(typeof handler === 'function')
    await handler()
    await new Promise(resolve => setImmediate(resolve))
    await nextTick()
  }
  return { button, click, text: () => text(root) }
}

test('rendered picker offers other local folders and registered remote folders, never an unregistered resource', async t => {
  const local: FolderRecord = { id: 'local', projectId: 'a', name: 'Local source', path: 'C:\\fixture\\source', createdAt: '2026-09-17' }
  const remote: FolderRecord = {
    id: 'remote', projectId: 'a', name: 'Remote source', path: '/display/source', createdAt: '2026-09-17', kind: 'remote',
    workdir: { version: 2, nodeId: 'laptop', workdirId: 'source' },
    identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
  }
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: string | URL, init?: RequestInit) => {
    assert.equal(init?.method, undefined, 'Browsing or selecting locations must not allocate anything')
    const path = new URL(input).pathname
    requests.push(path)
    if (path === '/projects/a/api/folders') return Response.json({ folders: [
      local, { ...local, id: 'other-local', name: 'Other local folder' }, remote,
      { ...remote, id: 'foreign', projectId: 'b', name: 'Foreign folder' },
    ] })
    assert.equal(path, '/nodes/v1')
    return Response.json({ version: 1, nodes: [{
      nodeId: 'laptop', displayName: 'Laptop', role: 'child', connection: 'connected', supportsManagedSessions: true, executionProtocol: 'compatible',
      workdirs: [
        { version: 2 as const, nodeId: 'laptop', workdirId: 'source', displayName: 'Remote source', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } },
        { version: 2 as const, nodeId: 'laptop', workdirId: 'foreign', displayName: 'Foreign resource', displayPath: '/foreign/private', online: true, support: { operations: ['filesystem.read','filesystem.write','workdir.git.status','workdir.git.diff','workdir.identity','workdir.process.execute','workdir.process.execute-once','workdir.process.reconcile'] } },
      ], support: { operations: ['workdir.session.allocate'] },
    }, { nodeId: 'old', displayName: 'Old device', role: 'child', connection: 'connected', executionProtocol: 'upgrade-required', workdirs: [], support: { operations: [] } }] })
  })
  const selections: Array<ExecutionLocation | undefined> = []
  const props = reactive({
    apiBase: 'http://fixture/projects/a/', projectId: 'a', folder: local as FolderRecord | undefined,
    onSelect: (selection: ExecutionLocation | undefined) => {
      selections.push(selection)
      props.folder = selection?.kind === 'folder' ? selection.folder : undefined
    },
  })
  const view = mount(t, props)
  assert.deepEqual(requests, [])
  await view.click('Open locations')
  assert.match(view.text(), /Project folders/)
  assert.equal(view.button('Other local folder').props.disabled, false)
  assert.equal(view.button('Remote source').props.disabled, false)
  assert.doesNotMatch(view.text(), /Foreign folder|Foreign resource|\/foreign\/private/)
  assert.equal(view.button('Start from scratch on Laptop').props.disabled, false)
  assert.equal(view.button('Start from scratch on Old device').props.disabled, true)
  assert.match(view.text(), /Update Main and this device/)
  await view.click('Other local folder')
  assert.equal(selections[0]?.kind, 'folder')
  assert.equal(props.folder?.id, 'other-local')
  assert.equal(view.button('Other local folder').props['aria-pressed'], true)
  await view.click('Remote source')
  assert.equal(props.folder?.id, 'remote')
  await view.click('Start from scratch on Laptop')
  assert.equal(selections[2]?.kind, 'node')
  assert.equal(props.folder, undefined)
  await view.click('This computer')
  assert.equal(selections.length, 4)
  assert.equal(selections[3], undefined)
  assert.equal(requests.length, 2)
})
