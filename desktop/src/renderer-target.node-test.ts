import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRendererTarget } from './renderer-target.js'

test('renderer target accepts the existing loopback Vite development contract', () => {
  assert.deepEqual(resolveRendererTarget({ rendererDistPath: 'C:\\Shadow\\app\\dist', developmentUrl: 'http://localhost:5273' }), {
    kind: 'url',
    url: 'http://localhost:5273/',
    origin: 'http://localhost:5273',
  })
})

test('renderer target resolves the existing app/dist production build', () => {
  const target = resolveRendererTarget({ rendererDistPath: 'C:\\Shadow\\app\\dist' })
  assert.equal(target.kind, 'file')
  assert.match(target.filePath, /app[\\/]dist[\\/]index\.html$/)
})

test('renderer target rejects remote and HTTPS development pages', () => {
  assert.throws(
    () => resolveRendererTarget({ rendererDistPath: '.', developmentUrl: 'https://localhost:5273' }),
    /HTTP on loopback/,
  )
  assert.throws(
    () => resolveRendererTarget({ rendererDistPath: '.', developmentUrl: 'http://example.com:5273' }),
    /HTTP on loopback/,
  )
})