import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createModelCatalog } from './model-catalog.ts'

const tick = () => new Promise(resolve => setImmediate(resolve))

test('model catalogs stay lazy, coalesce reads, and reuse results independently of the caller', async t => {
  const requests: string[] = []
  const request: typeof fetch = async input => {
    requests.push(String(input))
    return Response.json({ models: ['configured-model'], providers: [{ id: 'account', type: 'copilot' }] })
  }
  const main = createModelCatalog('https://main.test', undefined, request)
  const a = createModelCatalog('https://main.test/projects/a/', undefined, request)
  const b = createModelCatalog('https://other.test/projects/a/', undefined, request)
  t.after(() => { main.dispose(); a.dispose(); b.dispose() })
  assert.deepEqual(requests, [])
  const controller = new AbortController()
  const first = a.read(controller.signal)
  const second = a.read()
  controller.abort()
  await assert.rejects(first, { name: 'AbortError' })
  assert.deepEqual((await second).models, ['configured-model'])
  assert.deepEqual((await a.read()).providers, [{ id: 'account', type: 'copilot' }])
  assert.deepEqual(requests, ['https://main.test/projects/a/api/models'])
  await main.read()
  await b.read()
  a.invalidate()
  assert.equal(a.value.value, undefined)
  assert.equal(a.revision.value, 1)
  await tick()
  assert.equal(requests.length, 3, 'invalidation must not initiate an idle read')
  await Promise.all([a.read(), b.read(), main.read()])
  assert.deepEqual(requests, ['https://main.test/projects/a/api/models', 'https://main.test/api/models',
    'https://other.test/projects/a/api/models', 'https://main.test/projects/a/api/models'])
})

test('invalidation discards an older in-flight response and failures can be retried', async t => {
  const pending: Array<(response: Response) => void> = []
  const catalog = createModelCatalog('https://main.test/projects/a', undefined, () => new Promise(resolve => pending.push(resolve)))
  t.after(catalog.dispose)
  const old = catalog.read()
  const rejected = assert.rejects(old, { name: 'AbortError' })
  await tick()
  catalog.invalidate()
  await rejected
  const failed = catalog.read()
  const malformed = assert.rejects(failed, /invalid models/)
  await tick()
  pending[1](Response.json({ models: null }))
  await malformed
  const fresh = catalog.read()
  await tick()
  pending[2](Response.json({ models: ['fresh'] }))
  await fresh
  pending[0](Response.json({ models: ['old'] }))
  await tick()
  assert.deepEqual(catalog.value.value?.models, ['fresh'])
})
