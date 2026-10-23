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
test('Child renderer policies follow only the selected loopback target and restore local recovery', async () => {
  const { rendererTargetController } = await import('./renderer-target.js')
  const { createNavigationPolicy } = await import('./security-policy.js')
  const local = resolveRendererTarget({ rendererDistPath: '/fixture/app-dist' })
  const controller = rendererTargetController(local)
  const policy = createNavigationPolicy(controller.target)
  const child = resolveRendererTarget({ rendererDistPath: '', developmentUrl: 'http://127.0.0.1:43123/' })
  controller.select(child)
  assert.equal(controller.target.kind, 'url')
  assert.equal(policy.isAllowed('http://127.0.0.1:43123/projects/default/chat'), true)
  assert.equal(policy.isAllowed('http://192.168.1.10:3123/'), false)
  assert.equal(policy.isAllowed('http://127.0.0.1:43124/'), false)
  controller.select(local)
  assert.equal(controller.target.kind, 'file')
  assert.equal(policy.isAllowed('http://127.0.0.1:43123/'), false)
  assert.equal(policy.isAllowed(local.kind === 'file' ? local.entryUrl : ''), true)
})
