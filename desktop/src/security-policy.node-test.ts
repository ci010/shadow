import assert from 'node:assert/strict'
import test from 'node:test'
import { createNavigationPolicy, isAllowedExternalUrl } from './security-policy.js'

test('navigation remains on the configured renderer origin', () => {
  const policy = createNavigationPolicy({ origin: 'http://localhost:5273' })
  assert.equal(policy.isAllowed('http://localhost:5273/chat?id=1'), true)
  assert.equal(policy.isAllowed('http://127.0.0.1:5273/chat'), false)
  assert.equal(policy.isAllowed('https://example.com'), false)
})

test('packaged navigation permits files but external opening only permits HTTP(S)', () => {
  const policy = createNavigationPolicy({
    origin: 'null',
    entryUrl: 'file:///C:/Shadow/app/dist/index.html',
  })
  assert.equal(policy.isAllowed('file:///C:/Shadow/app/dist/index.html'), true)
  assert.equal(policy.isAllowed('file:///C:/Shadow/app/dist/index.html#/chat'), true)
  assert.equal(policy.isAllowed('file:///C:/Windows/System32/cmd.exe'), false)
  assert.equal(policy.isAllowed('data:text/html,test'), false)
  assert.equal(isAllowedExternalUrl('https://example.com/docs'), true)
  assert.equal(isAllowedExternalUrl('file:///C:/Windows/System32/cmd.exe'), false)
  assert.equal(isAllowedExternalUrl('javascript:alert(1)'), false)
})