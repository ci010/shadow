import assert from 'node:assert/strict'
import { mkdir, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { ProcessManager } from './processes/manager.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { CapabilityWorkdirIdentity } from './capability-workdir-identity.ts'
import { LocalExecutor } from './local-executor.ts'
import { executeRemoteWorkdirIdentity } from './remote-workdir-identity-client.ts'
import { MAX_WORKDIR_IDENTITY_BYTES, parseWorkdirIdentity, workdirIdentitiesOverlap } from './workdir-identity.ts'
import type { Executor } from './executor.ts'

test('Child identity follows aliases, ancestry and filesystem case semantics across executor restarts', async t => {
  const { folders } = await folderFixture(t)
  const a = join(folders, 'CaseFolder')
  const child = join(a, 'child')
  const b = join(folders, 'other')
  const alias = join(folders, 'alias')
  await Promise.all([mkdir(child, { recursive: true }), mkdir(b)])
  await symlink(a, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const bindings = [{ capabilityId: 'a', rootPath: a }, { capabilityId: 'b', rootPath: b },
    { capabilityId: 'alias', rootPath: alias }, { capabilityId: 'child', rootPath: child }]
  const read = (executor: Executor, capabilityId: string) => executeRemoteWorkdirIdentity({
    executor, nodeId: 'child', capabilityId, sessionId: 'identity-test', turnId: 'identity-test', signal: new AbortController().signal,
  })
  const executor = () => new LocalExecutor(new ProcessManager(), 'child', [new CapabilityWorkdirIdentity(bindings)])
  const first = executor()
  const [one, two, linked, nested] = await Promise.all(['a', 'b', 'alias', 'child'].map(id => read(first, id)))
  assert.deepEqual(one, linked)
  assert.deepEqual(one, await read(executor(), 'a'))
  assert.equal(workdirIdentitiesOverlap(one, two), false)
  assert.equal(workdirIdentitiesOverlap(one, nested), true)
  assert.equal(workdirIdentitiesOverlap(nested, one), true)
  assert(!JSON.stringify(one).includes(folders))
  if (process.platform === 'win32') {
    const alternate = new LocalExecutor(new ProcessManager(), 'child', [
      new CapabilityWorkdirIdentity([{ capabilityId: 'a', rootPath: a.toUpperCase() }]),
    ])
    assert.deepEqual(one, await read(alternate, 'a'))
  }
  await assert.rejects(read(first, 'unknown'))
})

test('identity wire validator rejects unknown fields, malformed IDs and invalid ancestry', () => {
  const rootId = 'a'.repeat(64)
  for (const value of [null, {}, { version: 2, rootId, ancestorIds: [] },
    { version: 1, rootId: '/root', ancestorIds: [] }, { version: 1, rootId, ancestorIds: [rootId] },
    { version: 1, rootId, ancestorIds: ['b'.repeat(64), 'b'.repeat(64)] },
    { version: 1, rootId, ancestorIds: [], displayPath: '/root' }]) {
    assert.throws(() => parseWorkdirIdentity(value))
  }
})

test('identity client rejects malformed, oversized and incomplete replies without fallback', async () => {
  for (const output of ['{}', 'not json', 'x'.repeat(MAX_WORKDIR_IDENTITY_BYTES + 1), null]) {
    let calls = 0
    const executor: Executor = {
      async *execute(request) {
        calls++
        const timestamp = new Date().toISOString()
        if (output !== null) {
          yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk: output }
          yield { version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed',
            receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: timestamp } }
        }
      },
      getStatus: async () => null,
      cancel: async () => { throw new Error('Unused') },
    }
    await assert.rejects(executeRemoteWorkdirIdentity({
      executor, nodeId: 'child', capabilityId: 'workdir', sessionId: 'identity-test', turnId: 'identity-test',
      signal: new AbortController().signal,
    }))
    assert.equal(calls, 1)
  }
})
