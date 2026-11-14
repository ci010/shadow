import test from 'node:test'
import assert from 'node:assert/strict'
import { createPinia, disposePinia } from 'pinia'
import { createCatalogResources, useCatalogResourceStore } from '../stores/catalog.ts'

const tick = () => new Promise(resolve => setTimeout(resolve, 10))

test('completion projections share a single flight, release one lease safely, and isolate scope', async () => {
  let reads = 0
  const owner = createCatalogResources(async () => { reads++; return Response.json({ items: [] }) })
  const a = owner.completions('http://localhost/projects/a', 'a'), b = owner.completions('http://localhost/projects/a', 'a')
  try {
    await a.read()
    assert.equal(reads, 1)
    assert.equal(a.state, b.state)
    a.release()
    await b.refresh()
    assert.equal(reads, 2)
    const c = owner.completions('http://localhost/projects/b', 'b')
    await c.read(); assert.equal(reads, 3); assert.notEqual(c.state, b.state); c.release()
    b.release()
    await tick(); assert.equal(reads, 3)
  } finally { a.release(); b.release(); owner.dispose() }
})

test('last release aborts pending ownership and reacquisition cannot publish an old response', async () => {
  const requests: { signal: AbortSignal; resolve: (value: Response) => void }[] = []
  const owner = createCatalogResources((_url, init) => new Promise(resolve => requests.push({ signal: init!.signal!, resolve })))
  const old = owner.completions('http://localhost/projects/a', 'a')
  await tick(); old.release()
  assert.equal(requests[0]!.signal.aborted, true)
  const fresh = owner.completions('http://localhost/projects/a', 'a')
  await tick()
  requests[0]!.resolve(Response.json({ items: [] }))
  await tick(); assert.equal(fresh.state.value.value, undefined)
  requests[1]!.resolve(Response.json({ items: [] }))
  await fresh.read(); assert.deepEqual(fresh.state.value.value, [])
  fresh.release(); owner.dispose()
})

test('Pinia catalog owners isolate applications and dispose their leases', async () => {
  const a = createPinia(), b = createPinia()
  const first = useCatalogResourceStore(a), second = useCatalogResourceStore(b)
  assert.notEqual(first.owner, second.owner)
  assert.equal(first, useCatalogResourceStore(a))
  disposePinia(a); disposePinia(b)
  assert.throws(() => first.owner.completions('http://localhost/projects/a', 'a'), /disposed/)
})

test('protected read failure removes the previously authorized value', async () => {
  let denied = false
  const owner = createCatalogResources(async () => denied ? new Response('', { status: 403 }) : Response.json({ items: [] }))
  const lease = owner.completions('http://localhost/projects/a', 'a')
  await lease.read(); assert.deepEqual(lease.state.value.value, [])
  denied = true; await lease.refresh()
  assert.equal(lease.state.value.status, 'forbidden'); assert.equal(lease.state.value.value, undefined)
  lease.release(); owner.dispose()
})
