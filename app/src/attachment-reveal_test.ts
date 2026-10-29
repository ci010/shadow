import assert from 'node:assert/strict'
import test from 'node:test'
import { canRevealAttachment, createAttachmentReveal } from './attachment-reveal.ts'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}

test('reveal visibility excludes external and remote paths without fetching proof', () => {
  for (const path of ['uploads/a.zip', '/tmp/report.pdf', 'C:\\work\\report.pdf']) {
    assert.equal(canRevealAttachment(path, '/api/media', true), true)
  }
  for (const path of ['https://example.com/a', 'data:image/png;base64,abc', '//example.com/a', 'file:///tmp/a']) {
    assert.equal(canRevealAttachment(path, '/api/media', true), false)
  }
  assert.equal(canRevealAttachment('uploads/a', '/api/media', true, { kind: 'remote', displayPath: '/remote' }), false)
  assert.equal(canRevealAttachment('uploads/a', '/api/media', true, { kind: 'local', displayPath: '/local', available: false }), false)
  assert.equal(canRevealAttachment('uploads/a', null, true), false)
  assert.equal(canRevealAttachment('uploads/a', '/api/media', false), false)
})

test('proof is requested only on run, duplicate clicks stay pending through desktop validation', async () => {
  const state = { pending: new Set<string>(), error: false }
  const proof = deferred<unknown>()
  const desktop = deferred<boolean>()
  let fetches = 0
  let reveals = 0
  const action = createAttachmentReveal(state, async url => { assert.equal(url, '/media'); fetches++; return proof.promise }, async value => {
    assert.equal(value, 'signed-proof'); reveals++; return desktop.promise
  })
  assert.equal(fetches, 0)
  const run = action.run('a', '/media')
  await action.run('a', '/media')
  assert.equal(fetches, 1)
  assert.equal(state.pending.has('a'), true)
  proof.resolve('signed-proof')
  await Promise.resolve(); await Promise.resolve()
  assert.equal(reveals, 1)
  assert.equal(state.pending.has('a'), true)
  desktop.resolve(true)
  await run
  assert.equal(state.pending.size, 0)
  assert.equal(state.error, false)
})

test('identity reset aborts proof and ignores stale proof and stale desktop failure', async () => {
  const state = { pending: new Set<string>(), error: false }
  const proof = deferred<unknown>()
  let signal!: AbortSignal
  let reveals = 0
  const action = createAttachmentReveal(state, async (_, abort) => { signal = abort; return proof.promise }, async () => { reveals++; return false })
  const old = action.run('a', '/old')
  action.reset()
  assert.equal(signal.aborted, true)
  proof.resolve('old-proof')
  await old
  assert.equal(reveals, 0)
  assert.equal(state.error, false)
  const desktop = deferred<boolean>()
  const next = createAttachmentReveal(state, async () => 'proof', async () => desktop.promise)
  const pending = next.run('a', '/new')
  await Promise.resolve()
  next.reset()
  desktop.resolve(false)
  await pending
  assert.equal(state.error, false)
  assert.equal(state.pending.size, 0)
})

test('failed proof and rejected desktop validation retain error feedback and allow retry', async () => {
  for (const failure of ['fetch', 'missing', 'desktop']) {
    const state = { pending: new Set<string>(), error: false }
    let calls = 0
    const action = createAttachmentReveal(state, async () => {
      if (failure === 'fetch') throw new Error('HTTP 403')
      return failure === 'missing' ? undefined : 'proof'
    }, async () => { calls++; return false })
    await action.run('a', '/media')
    assert.equal(state.error, true)
    assert.equal(state.pending.size, 0)
    assert.equal(calls, failure === 'desktop' ? 1 : 0)
    action.reset()
    assert.equal(state.error, false)
  }
})
