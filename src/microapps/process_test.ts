import assert from 'node:assert/strict'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { terminateProcessTree } from '../execution/processes/manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { startAppProcess, type AppProcess } from './process.ts'

test('backend termination can be retried after a failed attempt instead of caching the rejection forever', async () => {
  await withTempWorkspace(async directory => {
    const data = join(directory, 'data')
    await mkdir(data)
    await writeFile(join(directory, 'server.mjs'), `
      import {createServer} from 'node:http';
      createServer((_request,response)=>response.end('ready'))
        .listen(Number(process.env.SHADOW_APP_PORT),'127.0.0.1');
    `)
    let attempts = 0
    const process = await startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, data,
      'http://127.0.0.1:1', 'synthetic-test-token', AbortSignal.timeout(20000), { terminate: async (...args) => {
        if (++attempts === 1) throw new Error('Synthetic termination failure')
        return terminateProcessTree(...args)
      } })
    try {
      await assert.rejects(process.stop(), /Synthetic termination failure/)
      assert.equal(process.child.exitCode, null)
      await Promise.all([process.stop(), process.stop()])
      assert.equal(attempts, 2)
      await process.exited
      assert.notEqual(process.child.exitCode ?? process.child.signalCode, null)
    } finally { await process.stop() }
  })

  test('the owner retains a backend when cancellation during startup cannot finish cleanup', async () => {
    await withTempWorkspace(async directory => {
      const data = join(directory, 'data')
      await mkdir(data)
      await writeFile(join(directory, 'server.mjs'), 'setInterval(()=>{},1000)')
      const controller = new AbortController()
      const owner: { backend?: AppProcess } = {}
      let attempts = 0
      try {
        await assert.rejects(startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, data,
          'http://127.0.0.1:1', 'synthetic-test-token', controller.signal, {
            onStarted: backend => { owner.backend = backend; controller.abort(new Error('Cancel startup')) },
            terminate: async (...args) => {
              if (++attempts === 1) throw new Error('Synthetic startup cleanup failure')
              return terminateProcessTree(...args)
            },
          }), /Synthetic startup cleanup failure/)
        assert.ok(owner.backend)
        assert.equal(owner.backend.child.exitCode, null)
        await owner.backend.stop()
        assert.equal(attempts, 2)
        await owner.backend.exited
        assert.notEqual(owner.backend.child.exitCode ?? owner.backend.child.signalCode, null)
      } finally { await owner.backend?.stop() }
    })

    test('a missing executable reports startup failure without making cleanup permanently fail', async t => {
      await withTempWorkspace(async directory => {
        const original = childProcess.spawn
        const mocked = t.mock.method(childProcess, 'spawn', (...args: Parameters<typeof original>) =>
          original(join(directory, 'missing-runtime'), args[1], args[2]))
        syncBuiltinESMExports()
        const owner: { backend?: AppProcess } = {}
        try {
          await assert.rejects(startAppProcess({ runtime: 'node', entry: 'server.mjs', args: [] }, directory, directory,
            'http://127.0.0.1:1', 'synthetic-test-token', AbortSignal.timeout(10000),
            { onStarted: backend => { owner.backend = backend } }), /ENOENT/)
          assert.ok(owner.backend)
          assert.equal(owner.backend.child.pid, undefined)
          assert.match(owner.backend.error!, /ENOENT/)
          await owner.backend.stop()
          assert.equal((await owner.backend.exited).success, false)
        } finally {
          mocked.mock.restore()
          syncBuiltinESMExports()
          await owner.backend?.stop()
        }
      })
    })
  })
})
