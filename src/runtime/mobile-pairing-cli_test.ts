import assert from 'node:assert/strict'
import { test } from 'node:test'
import { manageMobileAccess, runMobilePair } from './mobile-pairing-cli.ts'

const connection = { apiBase: 'http://127.0.0.1:3123', token: 'A'.repeat(43) }
const code = '1234-5678-ABCD-EF01-2345-6789'
test('mobile CLI uses protected loopback control and prints only a scoped pairing offer', async () => {
  const output = await manageMobileAccess(connection, { kind: 'pair' }, async (input, init) => {
    assert.equal(input, `${connection.apiBase}/local/v1/mobile-pairing`)
    assert.equal(init?.method, 'POST')
    assert.equal(init?.redirect, 'error')
    assert.equal(new Headers(init?.headers).get('Authorization'), `Bearer ${connection.token}`)
    return Response.json({ version: 1, url: 'https://main.example.test', code, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  })
  assert(output.includes(code))
  assert(!output.includes(connection.token))
})

test('mobile CLI rejects malformed, oversized, insecure and secret-bearing responses', async () => {
  for (const body of [
    { version: 1, url: 'http://main.example.test', code, expiresAt: new Date(Date.now() + 60_000).toISOString() },
    { version: 1, url: 'https://main.example.test', code, expiresAt: 'yesterday' },
    { version: 1, code: connection.token },
    { padding: 'x'.repeat(20_000) },
  ]) {
    await assert.rejects(manageMobileAccess(connection, { kind: 'pair' }, async () => Response.json(body)), /Could not manage mobile access/)
  }
  let requested = false
  await assert.rejects(manageMobileAccess({ ...connection, apiBase: 'https://evil.test' }, { kind: 'pair' }, async () => {
    requested = true
    return Response.json({})
  }))
  assert.equal(requested, false)
})

test('mobile CLI supports listing, revocation and non-secret help', async () => {
  const id = '12345678-1234-1234-1234-123456789abc'
  const expiry = new Date(Date.now() + 60_000).toISOString()
  assert((await manageMobileAccess(connection, { kind: 'list' }, async (_, init) => {
    assert.equal(init?.method, 'GET')
    return Response.json({ version: 1, sessions: [{ id, expiresAt: expiry }] })
  })).includes(id))
  assert((await manageMobileAccess(connection, { kind: 'revoke', id }, async (input, init) => {
    assert(String(input).endsWith(`/mobile-sessions/${id}`))
    assert.equal(init?.method, 'DELETE')
    return new Response(null, { status: 204 })
  })).includes('Revoked'))
  let help = ''
  await runMobilePair(['--help'], value => { help = value })
  assert(help.includes('SHADOW_MOBILE_ORIGIN'))
})

 test('mobile CLI accepts private HTTP only with explicit opt-in', async () => {
  const response = (url: string) => async () => Response.json({ version: 1, url, code, expiresAt: new Date(Date.now() + 60_000).toISOString() })
  await assert.rejects(manageMobileAccess(connection, { kind: 'pair' }, response('http://192.168.1.4:3125')))
  assert((await manageMobileAccess(connection, { kind: 'pair' }, response('http://192.168.1.4:3125'), true)).includes('http://192.168.1.4:3125'))
  await assert.rejects(manageMobileAccess(connection, { kind: 'pair' }, response('http://8.8.8.8:3125'), true))
 })
