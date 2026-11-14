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
