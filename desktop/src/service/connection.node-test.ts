import assert from 'node:assert/strict'
import test from 'node:test'
import { loadServiceConnection, parseServiceConnectionDescriptor, selectServiceConnectionPath } from './connection.js'

const descriptor = {
  version: 1, serviceName: 'ShadowService', role: 'main',
  apiBase: 'http://127.0.0.1:18800', port: 18800,
  credentialPath: 'C:\\ProgramData\\ShadowService\\control\\launch-token',
  configPath: 'C:\\ProgramData\\ShadowService\\control\\runtime-config.v1.json',
}

test('service attachment requires explicit absolute opt-in and rejects conflicting selections', () => {
  assert.equal(selectServiceConnectionPath(undefined, undefined), undefined)
  assert.equal(selectServiceConnectionPath(descriptor.configPath, undefined), descriptor.configPath)
  assert.throws(() => selectServiceConnectionPath('', undefined), /absolute/)
  assert.throws(() => selectServiceConnectionPath('relative.json', undefined), /absolute/)
  assert.throws(() => selectServiceConnectionPath('\\\\server\\share\\connection.json', undefined), /absolute/)
  assert.throws(() => selectServiceConnectionPath('C:\\a', 'C:\\b'), /Conflicting/)
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
  assert.deepEqual(await loadServiceConnection('C:\\connection.json', read), { descriptor, launchToken: secret })
  for (const token of ['', 'short', 'secret\r\nheader: value', JSON.stringify({ secret })]) {
    await assert.rejects(
      loadServiceConnection('C:\\connection.json', async (path) => path === descriptor.credentialPath ? token : JSON.stringify(descriptor)),
      (error: Error) => !error.message.includes(secret) && error.message.includes('could not be loaded'),
    )
  }
  await assert.rejects(loadServiceConnection('C:\\missing.json', async () => { throw new Error(secret) }), (error: Error) => !error.message.includes(secret))
})
