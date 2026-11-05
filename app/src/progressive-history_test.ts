import assert from 'node:assert/strict'
import test from 'node:test'
import { computed, effectScope, nextTick, ref } from 'vue'
import { historyPresentationRows, historyRevealRow, useProgressiveHistory, type HistoryFrameScheduler } from './progressive-history.ts'

function fixture(count = 19) {
  const callbacks = new Map<number, () => void>()
  let sequence = 0
  const scheduler: HistoryFrameScheduler = {
    request: callback => { callbacks.set(++sequence, callback); return sequence },
    cancel: handle => { callbacks.delete(handle) },
  }
  const rows = ref(Array.from({ length: count }, (_, idx) => ({ key: `key-${idx}`, idx })))
  const active = ref(true)
  const context = ref('session-a')
  const navigation = ref('/chat/a')
  let restored = 0
  const scope = effectScope()
  const history = scope.run(() => useProgressiveHistory({ rows: computed(() => rows.value.map(row => row)),
    key: row => row.key, context: () => context.value, active: () => active.value, navigation: () => navigation.value,
    beforeBatch: () => () => { restored++ }, scheduler }))!
  async function frame() {
    assert.equal(callbacks.size, 1, 'one future frame, not multiple batches queued together')
    const [handle, callback] = callbacks.entries().next().value!
    callbacks.delete(handle)
    callback()
    await nextTick()
  }
  return { rows, active, context, navigation, history, callbacks, scope, frame, restored: () => restored }
}

test('history mounting has bounded per-frame batches and retains original indices/keys', async () => {
  const f = fixture()
  try {
    const batches = [f.history.mountedRows.value.map(row => row.idx)]
    assert.deepEqual(batches[0], [15, 16, 17, 18])
    while (f.callbacks.size) { await f.frame(); batches.push(f.history.mountedRows.value.map(row => row.idx)) }
    assert.deepEqual(batches.map(batch => batch.length), [4, 8, 12, 16, 19])
    assert.equal(f.restored(), 4)
    assert.deepEqual(f.history.mountedRows.value, f.rows.value)
    assert.equal(f.callbacks.size, 0)
  } finally { f.scope.stop() }
})

test('append stays live; older prepend retains keys and source indices, never reindexes a tail slice', async () => {
  const f = fixture()
  try {
    f.rows.value.push({ key: 'live', idx: 19 })
    assert.deepEqual(f.history.mountedRows.value.map(row => row.idx), [15, 16, 17, 18, 19])
    f.rows.value = [{ key: 'older', idx: 0 }, ...f.rows.value.map(row => ({ ...row, idx: row.idx + 1 }))]
    assert.equal(f.history.mountedRows.value[0]!.key, 'key-15')
    assert.equal(f.history.mountedRows.value[0]!.idx, 16)
    const reveal = f.history.reveal('older')
    while (f.callbacks.size) await f.frame()
    assert.equal(await reveal, true)
    assert.equal(f.history.mountedRows.value[0]!.key, 'older')
  } finally { f.scope.stop() }
})

test('navigation waits for the real batch commit and aborts without exposing a different context', async () => {
  const f = fixture()
  try {
    let completed = false
    const reveal = f.history.reveal('key-0').then(value => { completed = true; return value })
    await f.frame()
    assert.equal(completed, false)
    f.context.value = 'session-b'
    assert.equal(await reveal, false)
    assert.equal(f.history.mountedRows.value.length, 4)
    const controller = new AbortController()
    const aborted = f.history.reveal('key-0', controller.signal)
    controller.abort()
    assert.equal(await aborted, false)
    const immediate = f.history.reveal('key-18')
    f.context.value = 'session-c'
    assert.equal(await immediate, false, 'even an already mounted target needs a generation guard')
  } finally { f.scope.stop() }
})

test('hidden/keepalive/unmount cancel frames and queued post-commit scroll restoration', async () => {
  const f = fixture()
  const callback = f.callbacks.values().next().value!
  f.callbacks.clear()
  callback() // DOM commit queued, but not flushed yet
  f.active.value = false
  await nextTick()
  assert.equal(f.restored(), 0)
  assert.equal(f.callbacks.size, 0)
  assert.equal(await f.history.reveal('key-0'), false)
  f.active.value = true
  assert.equal(f.callbacks.size, 1)
  const pending = f.history.reveal('key-0')
  f.scope.stop()
  assert.equal(await pending, false)
  assert.equal(f.callbacks.size, 0)
})

test('a tool group occupies one presentation row regardless of its original anchor index', async () => {
  const f = fixture(0)
  try {
    f.rows.value = [0, 1, 2, 3, 4, 5, 6, 1000].map(idx => ({ key: `anchor-${idx}`, idx }))
    assert.deepEqual(f.history.mountedRows.value.map(row => row.idx), [4, 5, 6, 1000])
    assert.equal(f.history.mountedRows.value.at(-1)!.key, 'anchor-1000')
  } finally { f.scope.stop() }
})

test('presentation selection retains long tool anchors and every execution/question/yield/I/O projection', () => {
  const messages = Array.from({ length: 1002 }, (_, idx) => ({ role: 'assistant', content: '',
    event: idx >= 3 && idx < 1001 ? 'tool_result' : undefined }))
  messages[0] = { role: 'user', content: 'first', event: undefined }
  messages[1001] = { role: 'assistant', content: 'latest', event: undefined }
  // Long group anchored at 2 covers almost the entire raw-message tail.
  const projected = [new Map([[2, { end: 1001 }]]), new Set([1]), new Set([500]), new Set([600]), new Set([700])]
  const rows = historyPresentationRows(messages, { entries: projected,
    after: [new Map([[800, ['io']]]), new Map([[900, ['yield revision']]])], boundaries: new Set([1000]) })
  assert.deepEqual(rows.map(row => row.idx), [0, 1, 2, 500, 600, 700, 800, 900, 1000, 1001])
  assert.equal(rows[2]!.msg, messages[2], 'retain original message identity, not a renumbered slice')
  const simple = historyPresentationRows(messages, { entries: [projected[0]!], after: [], boundaries: new Set() })
  assert.deepEqual(simple.slice(-4).map(row => row.idx), [0, 2, 1001], 'latest group anchor cannot disappear outside a raw tail cut')
})

test('route changes cancel a queued reveal but keep the already mounted history suffix', async () => {
  const f = fixture()
  try {
    await f.frame()
    const before = f.history.mountedRows.value.map(row => row.key)
    const pending = f.history.reveal('key-0')
    f.navigation.value = '/other'
    assert.equal(await pending, false)
    assert.deepEqual(f.history.mountedRows.value.map(row => row.key), before)
  } finally { f.scope.stop() }
})

test('ordinary streaming appends do not cancel a pending old-message reveal', async () => {
  const f = fixture()
  try {
    const pending = f.history.reveal('key-0')
    f.rows.value = [...f.rows.value, { key: 'live', idx: 19 }]
    while (f.callbacks.size) await f.frame()
    assert.equal(await pending, true)
  } finally { f.scope.stop() }
})

test('external decision navigation resolves its after anchor before tool-group lookup', () => {
  const rows = [{ idx: 0 }, { idx: 10 }, { idx: 30 }]
  const groups = new Map([[10, { end: 25 }]])
  const after = new Map([[0, [[100, {}] as const]], [20, [[101, {}] as const]]])
  assert.equal(historyRevealRow(100, rows, groups, after), rows[0])
  assert.equal(historyRevealRow(101, rows, groups, after), rows[1])
  assert.equal(historyRevealRow(30, rows, groups, after), rows[2])
  assert.equal(historyRevealRow(102, rows, groups, after), undefined, 'unlinked/streaming fallback stays with caller')
})
