import { createResourceStores } from './stores/app.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, createRenderer, defineComponent, h, nextTick, onUpdated, ref } from 'vue'
import { createCommitBottomScroll, firstSessionIndex } from './chat-render-hotspots.ts'

test('session index preserves first duplicate and tracks replacement, mutation and ID changes', () => {
  const sessions = ref([{ sessionId: 'a', label: 'first' }, { sessionId: 'a', label: 'second' }])
  const index = computed(() => firstSessionIndex(sessions.value))
  assert.equal(index.value.get('a')?.label, 'first')
  sessions.value[0]!.label = 'renamed'
  assert.equal(index.value.get('a')?.label, 'renamed')
  sessions.value[0]!.sessionId = 'b'
  assert.equal(index.value.get('a')?.label, 'second')
  sessions.value.unshift({ sessionId: 'a', label: 'inserted' })
  assert.equal(index.value.get('a')?.label, 'inserted')
  sessions.value = [{ sessionId: 'c', label: 'replacement' }]
  assert.equal(index.value.get('a'), undefined)
  assert.equal(index.value.get('c')?.label, 'replacement')
})

test('repeated indexed event lookups do not revisit session proxy fields', () => {
  let idReads = 0
  const sessions = Array.from({ length: 1000 }, (_, i) => ({
    get sessionId() { idReads++; return `session-${i}` },
  }))
  const index = firstSessionIndex(sessions)
  const buildReads = idReads
  for (let event = 0; event < 500; event++) assert.equal(index.get('session-999'), sessions[999])
  assert.equal(idReads, buildReads, '500 lookups add zero sessionId getter reads')
  assert.equal(buildReads, sessions.length, 'one ID read per session during index construction')
})

function layout() {
  let reads = 0, writes = 0, topReads = 0, top = 0, height = 100
  const element = {
    get scrollHeight() { reads++; return height },
    get scrollTop() { topReads++; return top },
    set scrollTop(value: number) { writes++; top = value },
  } as HTMLElement
  return { element, counts: () => ({ reads, writes, topReads }), resize: () => { height += 100 } }
}

test('same-commit sibling callbacks perform one height read, one scroll write and one top read', async () => {
  const follow = createCommitBottomScroll(), f = layout()
  await Promise.all([nextTick(() => follow(f.element, 1, 0, 0)), nextTick(() => follow(f.element, 1, 0, 0))])
  assert.deepEqual(f.counts(), { reads: 1, writes: 1, topReads: 1 })
  // Browser resize/image completion without a Vue commit must not reuse stale data.
  f.resize()
  assert.equal(follow(f.element, 1, 0, 0), 200)
  assert.deepEqual(f.counts(), { reads: 2, writes: 2, topReads: 2 })
})

test('different commit, user version, context generation and element never reuse a bottom write', () => {
  const follow = createCommitBottomScroll(), f = layout(), other = layout()
  follow(f.element, 1, 0, 0)
  follow(f.element, 2, 0, 0)
  follow(f.element, 2, 1, 0)
  follow(f.element, 2, 1, 1)
  follow(other.element, 2, 1, 1)
  assert.deepEqual(f.counts(), { reads: 4, writes: 4, topReads: 4 })
  assert.deepEqual(other.counts(), { reads: 1, writes: 1, topReads: 1 })
})

test('Vue component commit stamp coalesces bottom/progressive callbacks without delaying reveal', async () => {
  // Use Vue's real renderer/update/nextTick lifecycle rather than a simulated queue.
  type Node = { children: Node[] }
  const renderer = createRenderer<Node, Node>({
    patchProp() {}, insert(child, parent) { parent.children.push(child) }, remove() {},
    createElement: () => ({ children: [] }), createText: () => ({ children: [] }),
    createComment: () => ({ children: [] }), setText() {}, setElementText() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const rows = ref(4), f = layout(), follow = createCommitBottomScroll()
  let commit = 0
  const app = renderer.createApp(defineComponent({ setup() {
    onUpdated(() => { commit++ })
    return () => h('div', String(rows.value))
  } }))
  app.use(createResourceStores())
  app.mount({ children: [] })
  try {
    for (let batch = 0; batch < 3; batch++) {
      rows.value += 4
      const expected = batch + 1
      const bottom = nextTick(() => { assert.equal(commit, expected); follow(f.element, commit, 0, 0) })
      const progressive = nextTick(() => follow(f.element, commit, 0, 0))
      await Promise.all([bottom, progressive])
      assert.deepEqual(f.counts(), { reads: expected, writes: expected, topReads: expected })
    }
  } finally { app.unmount() }
})
