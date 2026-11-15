import test from 'node:test'
import assert from 'node:assert/strict'
import { resourceViews } from './vue-resource.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 10))
test('released consumers cannot reactivate a retained resource or affect remaining consumers', async () => {
  const views = resourceViews(4)
  let reads = 0
  const a = views.acquire('one', async () => ++reads), b = views.acquire('one', async () => ++reads)
  await a.read(); assert.equal(reads, 1)
  a.release(); await a.refresh(); a.invalidate(); await tick(); assert.equal(reads, 1)
  await b.refresh(); assert.equal(reads, 2)
  b.release(); await b.refresh(); b.invalidate(); await tick(); assert.equal(reads, 2)
  const c = views.acquire('one', async () => { throw new Error('retained adapter must be reused') })
  await c.read(); assert.equal(c.state.value.value, 2)
  c.release(); views.dispose()
})

test('app disposal publishes cleared state before disconnecting readonly views', async () => {
  const views = resourceViews()
  const lease = views.acquire('protected', async () => 'synthetic')
  await lease.read(); assert.equal(lease.state.value.value, 'synthetic')
  views.dispose(); assert.equal(lease.state.value.value, undefined)
  assert.equal(lease.state.value.status, 'disposed')
  await lease.refresh(); lease.release()
})

test('confirmed command publication cancels stale reads and survives failed reconciliation without command replay', async () => {
  const views = resourceViews()
  let reads = 0, finish!: (value: string[]) => void
  const a = views.acquire('catalog', async () => {
    if (++reads === 1) return ['kept', 'deleted']
    if (reads === 2) return new Promise<string[]>(resolve => { finish = resolve })
    throw new Error('reconciliation unavailable')
  })
  const b = views.acquire('catalog', async () => [])
  try {
    await a.read()
    const pending = b.refresh(); await tick()
    assert.equal(reads, 2)
    let commands = 0
    assert.equal(a.commit(value => { commands++; return value.filter(id => id !== 'deleted') }), true)
    await b.read()
    assert.equal(commands, 1); assert.equal(reads, 3)
    assert.equal(b.state.value.status, 'error')
    assert.deepEqual(b.state.value.value, ['kept'])
    finish(['kept', 'deleted']); await pending; await tick()
    assert.deepEqual(b.state.value.value, ['kept'], 'The read captured before the command cannot resurrect a deleted entry')
    a.release()
    assert.equal(a.commit(() => []), false)
    assert.deepEqual(b.state.value.value, ['kept'])
  } finally { a.release(); b.release(); views.dispose() }
})
