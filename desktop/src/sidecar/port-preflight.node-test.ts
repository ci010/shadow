import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import test from 'node:test'
import { isLoopbackPortOccupied } from './port-preflight.js'

test('loopback preflight identifies a listener without sending any data', async () => {
  const server = createServer(socket => {
    socket.on('data', () => assert.fail('preflight must not send credentials or requests'))
    socket.resume()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    assert.equal(await isLoopbackPortOccupied(address.port), true)
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  assert.equal(await isLoopbackPortOccupied(address.port), false)
})
