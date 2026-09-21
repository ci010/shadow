import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { resolveRendererTarget } from './renderer-target.js'

const rendererDistPath = resolve('fixtures', 'Shadow Desktop', 'app', 'dist')

test('renderer target accepts the existing loopback Vite development contract', () => {
  assert.deepEqual(resolveRendererTarget({ rendererDistPath, developmentUrl: 'http://localhost:5273' }), {
    kind: 'url',
    url: 'http://localhost:5273/',
    origin: 'http://localhost:5273',
  })
})

test('renderer target resolves the existing app/dist production build', () => {
  const filePath = join(rendererDistPath, 'index.html')
  assert.deepEqual(resolveRendererTarget({ rendererDistPath }), {
    kind: 'file',
    filePath,
    entryUrl: pathToFileURL(filePath).toString(),
    origin: 'null',
  })
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