import assert from 'node:assert/strict'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { loadServiceConnection, parseServiceConnectionDescriptor, selectServiceConnectionPath } from './connection.js'

const controlPath = resolve('fixtures', 'Shadow Service', 'control')
const connectionPath = join(controlPath, 'connection.v1.json')
const descriptor = {
  version: 1, serviceName: 'ShadowService', role: 'main',
  apiBase: 'http://127.0.0.1:18800', port: 18800,
  credentialPath: join(controlPath, 'launch-token'),
  configPath: join(controlPath, 'runtime-config.v1.json'),
}

test('service attachment requires explicit absolute opt-in and rejects conflicting selections', () => {
  assert.equal(selectServiceConnectionPath(undefined, undefined), undefined)
  assert.equal(selectServiceConnectionPath(connectionPath, undefined), connectionPath)
  assert.equal(selectServiceConnectionPath(undefined, connectionPath), connectionPath)
  assert.equal(selectServiceConnectionPath(connectionPath, connectionPath), connectionPath)
  assert.throws(() => selectServiceConnectionPath('', undefined), /absolute/)
  assert.throws(() => selectServiceConnectionPath('relative.json', undefined), /absolute/)
  assert.throws(() => selectServiceConnectionPath('\\\\server\\share\\connection.json', undefined), /absolute/)
  assert.throws(() => selectServiceConnectionPath(connectionPath, join(controlPath, 'other.json')), /Conflicting/)
})

test('validates exact versioned service metadata and loopback/port/role binding', () => {
  assert.deepEqual(parseServiceConnectionDescriptor(descriptor), descriptor)
  for (const patch of [
    { version: 2 }, { serviceName: 'OtherService' }, { role: 'child' },
    { port: 0 }, { port: 65536 }, { port: 18801 }, { port: '18800' },
    { apiBase: 'http://localhost:18800' }, { apiBase: 'http://example.com:18800' },
    { apiBase: 'http://127.0.0.1:18800/path' }, { apiBase: 'http://user@127.0.0.1:18800' },
    { apiBase: 'http://127.0.0.1:18800/' }, { apiBase: 'https://127.0.0.1:18800' },
    { credentialPath: 'relative' }, { configPath: 'relative' },
    { token: 'do-not-inline-credentials' },
  ]) {
    assert.throws(() => parseServiceConnectionDescriptor({ ...descriptor, ...patch }))
  }
})

test('loads credentials only in main process and never echoes sensitive malformed input', async () => {
  const secret = 'a'.repeat(43)
  const read = async (path: string) => path === descriptor.credentialPath ? secret : JSON.stringify(descriptor)
  assert.deepEqual(await loadServiceConnection(connectionPath, read), { descriptor, launchToken: secret })
  for (const token of ['', 'short', 'secret\r\nheader: value', JSON.stringify({ secret })]) {
    await assert.rejects(
      loadServiceConnection(connectionPath, async (path) => path === descriptor.credentialPath ? token : JSON.stringify(descriptor)),
      (error: Error) => !error.message.includes(secret) && error.message.includes('could not be loaded'),
    )
  }
  await assert.rejects(loadServiceConnection(join(controlPath, 'missing.json'), async () => { throw new Error(secret) }), (error: Error) => !error.message.includes(secret))
})
