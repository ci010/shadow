import assert from 'node:assert/strict'
import test from 'node:test'
import { RendererReadiness } from './renderer-readiness.js'

test('HTML success without an application handshake returns to recovery and requires explicit retry', async () => {
  const context = new RendererReadiness(() => { failures++ }, 20)
  let failures = 0
  context.wait()
  await new Promise(resolve => setTimeout(resolve, 40))
  assert.equal(failures, 1)
  assert.equal(context.failed, true)
  context.retry()
  assert.equal(context.failed, false)
  context.ready()
})

test('an application handshake or window disposal cancels the renderer failure deadline', async () => {
  let failures = 0
  const context = new RendererReadiness(() => { failures++ }, 10)
  context.wait()
  context.ready()
  await new Promise(resolve => setTimeout(resolve, 30))
  assert.equal(failures, 0)
  assert.equal(context.failed, false)
})
