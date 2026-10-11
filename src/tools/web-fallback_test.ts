import assert from 'node:assert/strict'
import test from 'node:test'
import { FirecrawlSearchTool } from './web.ts'
import type { ExecutionContext } from './context.ts'

const blocked = () => Response.json({ error: 'Unfortunately, your IP address looks suspicious' }, { status: 403 })
const success = () => Response.json({ data: { web: [{ title: 'Docs', url: 'https://example.com' }] } })

test('IP rejection retries once directly only when route uses a proxy, sharing request and deadline', async t => {
  const initial = t.mock.method(globalThis, 'fetch', async () => blocked())
  let retries = 0
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { return true },
    async directFetch(url, init) {
      retries++
      assert.equal(url, initial.mock.calls[0].arguments[0])
      assert.equal(init, initial.mock.calls[0].arguments[1])
      assert.ok(init.signal)
      return success()
    },
  })
  assert.equal(await tool.execute({ query: 'docs' }), '1. Docs\n   https://example.com')
  assert.equal(retries, 1)
  assert.equal(initial.mock.callCount(), 1)
})

test('IP rejection on a direct route does not retry or blame an API key', async t => {
  t.mock.method(globalThis, 'fetch', async () => blocked())
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { return false },
    async directFetch() { throw new Error('Unexpected retry') },
  })
  assert.match(await tool.execute({ query: 'docs' }), /blocked the request IP \(403\)/)
})

for (const [status, error] of [[403, 'Access denied'], [401, 'Invalid API key'], [429, 'IP address blocked']] as const) {
  test(`${status} ${error} does not resolve proxy or retry`, async t => {
    const request = t.mock.method(globalThis, 'fetch', async () => Response.json({ error }, { status }))
    const tool = new FirecrawlSearchTool(undefined, undefined, {
      async hasProxy() { throw new Error('Unexpected route resolution') },
      async directFetch() { throw new Error('Unexpected retry') },
    })
    assert.match(await tool.execute({ query: 'docs' }), new RegExp(String(status)))
    assert.equal(request.mock.callCount(), 1)
  })
}

test('failed direct connection is actionable and does not expose private network errors', async t => {
  t.mock.method(globalThis, 'fetch', async () => blocked())
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { return true },
    async directFetch() { throw new Error('private network details') },
  })
  const result = await tool.execute({ query: 'docs' })
  assert.match(result, /single direct retry failed/)
  assert.doesNotMatch(result, /private network details/)
})

test('direct HTTP failure remains visible without a second retry', async t => {
  t.mock.method(globalThis, 'fetch', async () => blocked())
  let retries = 0
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { return true },
    async directFetch() { retries++; return blocked() },
  })
  assert.match(await tool.execute({ query: 'docs' }), /direct retry returned 403/)
  assert.equal(retries, 1)
})

test('cancellation during proxy resolution prevents retry', async t => {
  t.mock.method(globalThis, 'fetch', async () => blocked())
  const controller = new AbortController()
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { controller.abort(); return true },
    async directFetch() { throw new Error('Unexpected retry') },
  })
  await assert.rejects(tool.execute({ query: 'docs' }, { signal: controller.signal } as ExecutionContext), { name: 'AbortError' })
})

test('cancellation during direct retry propagates', async t => {
  t.mock.method(globalThis, 'fetch', async () => blocked())
  const controller = new AbortController()
  const tool = new FirecrawlSearchTool(undefined, undefined, {
    async hasProxy() { return true },
    async directFetch(_url, init) { controller.abort(); init.signal!.throwIfAborted(); return success() },
  })
  await assert.rejects(tool.execute({ query: 'docs' }, { signal: controller.signal } as ExecutionContext), { name: 'AbortError' })
})
