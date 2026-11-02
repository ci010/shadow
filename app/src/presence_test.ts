import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { startPresence } from './presence.ts'

function target() {
  const listeners = new Map<string, (event: Event) => void>()
  return { listeners, addEventListener: (key: string, fn: (event: Event) => void) => listeners.set(key, fn),
    removeEventListener: (key: string) => listeners.delete(key) }
}

test('client reports visibility/focus but only trusted input changes interaction age, not heartbeat/focus', async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const window = target()
  const document = { ...target(), visibilityState: 'visible', hasFocus: () => true }
  const sent: Record<string, unknown>[] = []
  const stop = startPresence('http://localhost/projects/demo', window as unknown as Window, document as unknown as Document,
    undefined, async (url, init) => {
      assert.equal(String(url), 'http://localhost/projects/demo/api/chat/presence')
      sent.push(JSON.parse(init!.body as string))
      return Response.json({ ok: true })
    })
  await setImmediate()
  assert.equal(sent[0].interactionAgeMs, null)
  assert.equal(sent[0].system, null)
  now = 15_000
  t.mock.timers.tick(15_000)
  await setImmediate()
  assert.equal(sent[1].interactionAgeMs, null)
  window.listeners.get('keydown')!({ isTrusted: false } as Event)
  window.listeners.get('focus')!({} as Event)
  await setImmediate()
  assert.equal(sent.at(-1)!.interactionAgeMs, null)
  window.listeners.get('pointerdown')!({ isTrusted: true } as Event)
  now += 500
  document.listeners.get('visibilitychange')!({} as Event)
  await setImmediate()
  assert.equal(sent.at(-1)!.interactionAgeMs, 500)
  assert.equal(new Set(sent.map(report => report.clientId)).size, 1)
  assert.equal('userId' in sent[0], false)
  stop()
  assert.equal(window.listeners.size, 0)
  assert.equal(document.listeners.size, 0)
  const count = sent.length
  t.mock.timers.tick(30_000)
  assert.equal(sent.length, count)
})

test('native collection failure is capability-unknown, not away', async () => {
  const window = target(), document = { ...target(), visibilityState: 'hidden', hasFocus: () => false }
  let sent: Record<string, unknown> | undefined
  const stop = startPresence('http://localhost', window as unknown as Window, document as unknown as Document,
    { system: async () => { throw new Error('Unsupported') } }, async (_url, init) => {
      sent = JSON.parse(init!.body as string)
      return Response.json({ ok: true })
    })
  try { await setImmediate(); assert.equal(sent?.system, null); assert.equal(sent?.interactionAgeMs, null) }
  finally { stop() }
})

for (const status of [200, 401]) {
  test(`presence drains ${status} response and keeps one request in flight until body ends`, async () => {
    const window = target(), document = { ...target(), visibilityState: 'visible', hasFocus: () => true }
    let requests = 0
    let response: Response | undefined
    let finish!: () => void
    const stop = startPresence('http://localhost', window as unknown as Window, document as unknown as Document,
      undefined, async () => {
        requests++
        response = new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode('{"ok":true}'))
          finish = () => controller.close()
        } }), { status })
        return response
      })
    try {
      await setImmediate()
      assert.equal(response?.bodyUsed, true, 'fetch headers alone must not finish the heartbeat')
      window.listeners.get('focus')!({} as Event)
      await setImmediate()
      assert.equal(requests, 1)
      finish()
      await setImmediate()
      window.listeners.get('blur')!({} as Event)
      await setImmediate()
      assert.equal(requests, 2, 'body completion releases the in-flight guard')
      finish()
      await setImmediate()
    } finally { stop() }
  })
}
