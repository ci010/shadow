import assert from 'node:assert/strict'
import test from 'node:test'
import { childPairingFailureCode } from './child-pairing-diagnostics.ts'
import { ProtectedKeyStoreError } from '../cluster/protected-device-key-stores.ts'

test('pairing failures are finite actionable categories, not error messages or credentials', () => {
  assert.equal(childPairingFailureCode(new ProtectedKeyStoreError('provider-unavailable', 'secret')), 'key-store')
  assert.equal(childPairingFailureCode(new Error('Main pairing request failed with status 403')), 'offer-rejected')
  assert.equal(childPairingFailureCode(new Error('Main pairing request failed with status 503')), 'main-response')
  assert.equal(childPairingFailureCode(new Error('fetch failed', { cause: { code: 'ENOTFOUND', secret: '123456' } })), 'network')
  assert.equal(childPairingFailureCode(new DOMException('secret', 'TimeoutError')), 'timeout')
  assert.equal(childPairingFailureCode(new Error('secret=123456 invitation=private')), 'unknown')
  assert.equal(childPairingFailureCode('secret'), 'unknown')
})
