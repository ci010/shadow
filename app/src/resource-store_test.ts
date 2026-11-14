import test from 'node:test'
import assert from 'node:assert/strict'
import { createRenderer, defineComponent, h } from 'vue'
import { createResourceStores, requireResourcePinia } from './stores/app.ts'
import { useLiveClientPool } from './composables/useLiveClient.ts'
import { useProjectLiveState } from './composables/useProjectLiveState.ts'
import { useLiveTransportStore } from './stores/live.ts'
import { useProjectResourceStore } from './stores/project.ts'

type Node = { children: Node[]; parent?: Node }
const renderer = createRenderer<Node, Node>({
  createElement: () => ({ children: [] }), createText: () => ({ children: [] }), createComment: () => ({ children: [] }),
  insert(node, parent, anchor) {
    node.parent = parent
    const index = anchor ? parent.children.indexOf(anchor) : -1
    if (index < 0) parent.children.push(node)
    else parent.children.splice(index, 0, node)
  },
  remove(node) { const siblings = node.parent?.children; if (siblings) siblings.splice(siblings.indexOf(node), 1) },
  setText() {}, setElementText() {}, patchProp() {},
  parentNode: node => node.parent ?? null,
  nextSibling: node => node.parent?.children[node.parent.children.indexOf(node) + 1] ?? null,
})

function mount() {
  const captures: { pool: ReturnType<typeof useLiveClientPool>; owner: ReturnType<typeof useProjectLiveState> }[] = []
  const child = defineComponent({ setup() {
    const pinia = requireResourcePinia()
    const pool = useLiveClientPool(), owner = useProjectLiveState()
    assert.equal(pool, useLiveTransportStore(pinia).pool)
    assert.equal(owner, useProjectResourceStore(pinia).owner)
    captures.push({ pool, owner })
    return () => h('span')
  } })
  const app = renderer.createApp(defineComponent({ setup: () => () => [h(child), h(child)] }))
  app.use(createResourceStores())
  app.mount({ children: [] })
  return { app, captures, ...captures[0]! }
}

test('Pinia facades share owners within a root and isolate separate Vue roots/auth remounts', () => {
  const a = mount(), b = mount()
  try {
    assert.equal(a.captures[0]!.pool, a.captures[1]!.pool)
    assert.equal(a.captures[0]!.owner, a.captures[1]!.owner)
    assert.notEqual(a.pool, b.pool)
    assert.notEqual(a.owner, b.owner)
    assert.equal(a.pool.client('http://fixture/projects/a'), a.pool.client('http://fixture/projects/b'))
    assert.notEqual(a.pool.client('http://fixture'), b.pool.client('http://fixture'))
  } finally { a.app.unmount(); b.app.unmount() }
  const c = mount()
  try { assert.notEqual(c.owner, a.owner); assert.notEqual(c.pool, a.pool) } finally { c.app.unmount() }
})

test('app unmount disposes transport and resource ownership once without touching a sibling root', () => {
  const a = mount(), b = mount()
  const client = a.pool.client('http://fixture')
  let disposed = 0
  a.pool.onDispose(() => disposed++)
  a.app.unmount()
  a.pool.dispose()
  assert.equal(disposed, 1)
  assert.throws(() => a.pool.client('http://new-host'), /disposed/)
  assert.throws(() => a.pool.observe(() => {}), /disposed/)
  assert.throws(() => a.pool.observeHost('http://fixture', () => {}), /disposed/)
  assert.throws(() => client.subscribe({ kind: 'projects' }, { event() {}, reset() {} }), /disposed/)
  assert.throws(() => a.owner.acquireCatalog('http://fixture'), /disposed/)
  assert.doesNotThrow(() => b.pool.client('http://fixture'))
  b.app.unmount()
})

test('missing app context cannot borrow the most recently active Pinia', () => {
  const a = mount()
  try {
    assert.throws(() => requireResourcePinia(), /resource Pinia installed/)
    assert.throws(() => useLiveClientPool(), /Vue application context/)
    assert.throws(() => useProjectLiveState(), /Vue application context/)
  } finally { a.app.unmount() }
})

test('one resource plugin cannot install its auth-scoped Pinia into another app', () => {
  const plugin = createResourceStores()
  const a = renderer.createApp({ render: () => null }), b = renderer.createApp({ render: () => null })
  a.use(plugin)
  assert.throws(() => b.use(plugin), /cannot be shared/)
  a.mount({ children: [] }); a.unmount()
})
