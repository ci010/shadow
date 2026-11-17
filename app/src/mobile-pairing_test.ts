import assert from 'node:assert/strict'
import test from 'node:test'
import { formatPhonePairing, parsePhonePairing } from './mobile-pairing.ts'

const details = { url: 'https://main.example', code: 'abcd-abcd-abcd-abcd-abcd-abcd', expiresAt: new Date(Date.now() + 300000).toISOString() }
test('phone clipboard round trips canonical versioned and legacy whitespace formats', () => {
  assert.deepEqual(parsePhonePairing(formatPhonePairing({ ...details, url: 'https://MAIN.example:443/' })), details)
  assert.deepEqual(parsePhonePairing(` \n ${details.url}\r\n\t${details.code}  ${details.expiresAt} \n`), details)
  assert.deepEqual(parsePhonePairing(`${details.url} ${details.code}`), { url: details.url, code: details.code })
})
test('phone clipboard never grants HTTP consent or accepts unsafe origins', () => {
  for (const url of ['http://192.168.1.1:3125', 'http://example.com', 'https://main.example/path', 'https://user:pass@main.example', 'https://main.example/?code=secret', 'https://main.example/#secret', 'javascript:alert(1)', 'https://main.example\\evil', 'http://8.8.8.8']) {
    assert.throws(() => parsePhonePairing(`${url} ${details.code}`))
  }
  assert.equal(parsePhonePairing(`http://192.168.1.1:3125 ${details.code}`, true).url, 'http://192.168.1.1:3125')
  assert.throws(() => parsePhonePairing(`http://example.com ${details.code}`, true))
})
test('phone clipboard rejects malformed, expired or unknown details without echoing secrets', () => {
  for (const value of ['secret', `Shadow-Phone/2 ${details.url} ${details.code}`, `${details.url} bad-code`, `${details.url} ${details.code} invalid`, `${details.url} ${details.code} 2000-01-01T00:00:00Z`, `${details.url} ${details.code} ${details.expiresAt} extra`]) {
    assert.throws(() => parsePhonePairing(value), error => error instanceof Error && !error.message.includes(details.code) && !error.message.includes('secret'))
  }
})
