import assert from 'node:assert/strict'
import test from 'node:test'
import { decodeChildInvitation, encodeChildInvitation } from './device-pairing-invitation.ts'

const invitation = { version: 1 as const, offerId: 'offer-1', pin: '000012', expiresAt: '2030-01-01T00:00:00.000Z' }
const endpoint = 'http://192.168.1.12:3124'
const now = Date.parse('2029-01-01')

test('one copied Child invitation preserves endpoint, offer, leading-zero PIN and expiry', () => {
  const encoded = encodeChildInvitation(endpoint, invitation)
  assert.deepEqual(decodeChildInvitation(` \n${encoded}\n `, now), { ...invitation, endpoint })
  assert.ok(!encoded.startsWith('http'), 'Invitation must not act as a navigable web URL')
})

test('expired invitations are rejected at the boundary with actionable feedback', () => {
  assert.throws(() => decodeChildInvitation(encodeChildInvitation(endpoint, invitation), Date.parse(invitation.expiresAt)), /expired.*new invitation/)
})

test('malformed and unsafe invitations fail without reflecting secrets', () => {
  const wrap = (value: unknown) => 'shadow-child:v1:' + btoa(JSON.stringify(value))
  for (const input of [
    '', 'https://example.com', 'shadow-child:v2:abc', 'shadow-child:v1:!bad!',
    'shadow-child:v1:' + 'a'.repeat(4096), wrap(null),
    wrap({ ...invitation, endpoint, version: 2 }),
    wrap({ ...invitation, endpoint, pin: '12' }),
    wrap({ ...invitation, endpoint, expiresAt: 'not-a-date' }),
    wrap({ ...invitation, endpoint, offerId: 'invalid id' }),
    ...['file:///tmp/', 'javascript:alert(1)', 'http://user:secret@host', 'http://host/path',
      'http://host/?pin=000012', 'http://host/#000012'].map(endpoint => wrap({ ...invitation, endpoint })),
  ]) {
    assert.throws(() => decodeChildInvitation(input, now), error =>
      error instanceof Error && error.message === 'Invalid Child invitation. Copy the complete invitation from Main > Nodes.')
  }
})
