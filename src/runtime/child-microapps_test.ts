import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { ChildMicroApps, CHILD_APP_LIMITS } from './child-microapps.ts'

const launch = () => ({ url: `http://127.0.0.1:12345/#shadow_ticket=${'a'.repeat(43)}`, revision: 'a'.repeat(64), runId: randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() })
const result = () => Response.json({ status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('ok').toString('base64') })

test('Child relay caps listeners, serializes duplicate opens and releases slots on stop/shutdown', async () => {
  const apps = new ChildMicroApps()
  try {
    const value = launch()
    const duplicate = await Promise.all(Array.from({ length: 4 }, () => apps.open('/same', value, async () => result()))) as { url: string }[]
    assert.equal(new Set(duplicate.map(item => item.url)).size, 1)
    for (let index = 1; index < CHILD_APP_LIMITS.listeners; index++) await apps.open(`/app-${index}`, launch(), async () => result())
    await assert.rejects(apps.open('/over-limit', launch(), async () => result()), /limit reached/)
    await apps.stop('/same')
    await assert.rejects(fetch(new URL(duplicate[0]!.url).origin), /fetch failed/)
    const replacement = await apps.open('/replacement', launch(), async () => result()) as { url: string }
    await apps.close()
    await assert.rejects(fetch(new URL(replacement.url).origin), /fetch failed/)
    await assert.rejects(apps.open('/closed', launch(), async () => result()), /Child stopped/)
  } finally { await apps.close() }
})

test('Child relay bounds in-flight requests and rejects oversized request bodies before forwarding', async () => {
  const apps = new ChildMicroApps(), release = Promise.withResolvers<void>(), full = Promise.withResolvers<void>()
  let count = 0
  const opened = await apps.open('/app', launch(), async () => {
    count++; if (count === CHILD_APP_LIMITS.requests) full.resolve()
    await release.promise; return result()
  }) as { url: string }
  const origin = new URL(opened.url).origin
  try {
    const pending = Array.from({ length: CHILD_APP_LIMITS.requests }, () => fetch(origin))
    await full.promise
    const busy = await fetch(origin)
    assert.equal(busy.status, 429); await busy.body?.cancel()
    assert.equal(count, CHILD_APP_LIMITS.requests)
    release.resolve()
    for (const response of await Promise.all(pending)) { assert.equal(response.status, 200); await response.body?.cancel() }
    const oversized = await fetch(origin, { method: 'POST', body: Buffer.alloc(CHILD_APP_LIMITS.bodyBytes + 1) })
    assert.equal(oversized.status, 413); await oversized.body?.cancel()
    assert.equal(count, CHILD_APP_LIMITS.requests, 'Oversized body never obtains device proof or forwards')
  } finally { release.resolve(); await apps.close() }
})
