import assert from 'node:assert/strict'
import test from 'node:test'
import { parseChildStatus } from './child-status.ts'

const status = { version: 1, nodeId: 'child-1', mainEndpoint: 'https://main.test', connection: 'offline',
  error: 'Main has not authorized this device', fingerprint: 'sha256:fingerprint', dataDir: 'C:\\Child',
  workdirs: [{ capabilityId: 'work', rootPath: 'C:\\Work', displayName: 'Work folder' }], allowInsecureLocalTransport: false }
test('local Child status preserves offline/pending reality and rejects incomplete or unknown states', () => {
  assert.equal(parseChildStatus(status).connection, 'offline')
  assert.equal(parseChildStatus({ ...status, connection: 'connected', error: null }).connection, 'connected')
  for (const value of [null, {}, { ...status, connection: 'approved' }, { ...status, fingerprint: null },
    { ...status, workdirs: [{}] }, { ...status, error: false }]) assert.throws(() => parseChildStatus(value))
})
