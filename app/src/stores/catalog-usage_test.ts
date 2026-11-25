import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createCatalogResources } from './catalog.ts'

const base = 'http://fixture'
const payload = () => Response.json({ aggregate: null, rows: [] })

test('usage reacquisition keeps the cached snapshot visible during revalidation; auth denial clears it', async t => {
  let calls = 0
  let rejectRefresh!: (response: Response) => void
  const delayed = new Promise<Response>(resolve => { rejectRefresh = resolve })
  const catalog = createCatalogResources(async () => {
    calls++
    return calls === 1 ? payload() : calls === 2 ? delayed : new Response(null, { status: 403 })
  })
  t.after(() => catalog.dispose())
  const first = catalog.globalUsage(base)
  await first.read()
  const snapshot = first.state.value.value
  assert.ok(snapshot)
  first.release()
  const reopened = catalog.globalUsage(base)
  assert.equal(reopened.state.value.value, snapshot)
  assert.equal(reopened.state.value.loading, true)
  const refresh = reopened.read()
  rejectRefresh(new Response(null, { status: 500 }))
  await refresh
  assert.equal(reopened.state.value.value, snapshot)
  reopened.release()
  const retried = catalog.globalUsage(base)
  const retry = retried.read()
  await retry
  assert.equal(retried.state.value.value, undefined)
  assert.equal(retried.state.value.status, 'forbidden')
  retried.release()
})
