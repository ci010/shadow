import assert from 'node:assert/strict'
import test from 'node:test'
import { createMobileFetch, createMobileSession } from './mobile-client.ts'

for (const outcome of ['success', 'revoked', 'invalid', 'offline'] as const) {
  test(`file picker keeps only in-memory chat while paused; resume ${outcome}`, async t => {
    let saved: string | null = null
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    let checks = 0
    const session = createMobileSession({
      async get() { return { value: saved } }, async set({ value }) { saved = value }, async remove() { saved = null },
    }, async input => {
      if (String(input).endsWith('/pair')) return Response.json({ version: 1, accessToken: 'synthetic-picker-token', expiresAt: new Date(Date.now() + 3600000).toISOString() })
      checks++
      await pending
      if (outcome === 'offline') throw new TypeError('synthetic offline')
      return outcome === 'revoked' ? new Response(null, { status: 401 }) : Response.json({ version: 1, authenticated: outcome !== 'invalid', expiresAt: new Date(Date.now() + 3600000).toISOString() })
    })
    t.after(() => session.dispose())
    await session.pair('https://main.example', 'abcdef-abcdef-abcdef-abcdef')
    const finish = session.beginFilePicker()
    const signal = session.signal()
    session.setActive(false)
    session.setActive(false)
    assert.equal(session.view.value, 'paused')
    assert.equal(session.preserveChat.value, true)
    assert.equal(signal.aborted, true)
    const fetch = createMobileFetch({ fetch: async () => { assert.fail('No background/unchecked business request') }, credentials: session.credentials, webviewOrigin: 'https://localhost', signal: session.signal, unauthorized: session.unauthorized })
    await assert.rejects(fetch('/api/chat/send', { method: 'POST' }))
    session.setActive(true)
    session.setActive(true)
    assert.equal(checks, 1, 'duplicate resume cannot restart verification')
    assert.equal(session.view.value, 'loading')
    session.setActive(false)
    assert.equal(session.preserveChat.value, true, 'picker survives another real pause during verification')
    session.setActive(true)
    assert.equal(checks, 2)
    finish(); finish()
    assert.equal(session.preserveChat.value, true, 'change/cancel during verification cannot destroy the input')
    await assert.rejects(fetch('/api/chat/send', { method: 'POST' }))
    release()
    await new Promise(resolve => setImmediate(resolve))
    if (outcome === 'success') {
      assert.equal(session.view.value, 'connected')
      assert.equal(session.signal().aborted, false)
      session.setActive(false)
      assert.equal(session.preserveChat.value, false, 'ordinary background still unmounts after picker completion')
    } else {
      assert.equal(session.preserveChat.value, false)
      assert.equal(session.signal().aborted, true)
      assert.equal(session.view.value, outcome === 'revoked' ? 'pairing' : 'error')
      if (outcome === 'revoked') assert.equal(saved, null)
    }
  })
}

test('cancelled picker cannot retain chat on a later ordinary background; stale completion cannot close another picker', async t => {
  const session = createMobileSession({ async get() { return { value: null } }, async set() {}, async remove() {} }, async () => Response.json({ version: 1, authenticated: true, accessToken: 'synthetic-picker-token', expiresAt: new Date(Date.now() + 3600000).toISOString() }))
  t.after(() => session.dispose())
  await session.pair('https://main.example', 'abcdef-abcdef-abcdef-abcdef')
  const cancelled = session.beginFilePicker()
  cancelled()
  session.setActive(false)
  assert.equal(session.preserveChat.value, false)
  session.setActive(true)
  await new Promise(resolve => setImmediate(resolve))
  const stale = session.beginFilePicker()
  const current = session.beginFilePicker()
  stale()
  session.setActive(false)
  assert.equal(session.preserveChat.value, true)
  current()
  await session.disconnect()
  assert.equal(session.preserveChat.value, false)
  assert.equal(session.credentials(), undefined)
})
