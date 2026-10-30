import assert from 'node:assert/strict'
import { test } from 'node:test'
import { access, mkdir, realpath, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { ProcessManager } from './processes/manager.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CapabilityShell, parseWorkdirProcessArgs, WORKDIR_PROCESS_EXECUTE_OPERATION } from './capability-shell.ts'
import { LocalExecutor } from './local-executor.ts'
import { CapabilityFilesystem } from './capability-filesystem.ts'
import { RemoteExecutor } from './remote-executor.ts'
import { executeRemoteShell } from './remote-shell-client.ts'
import { requestedSafegitBinary, SAFEGIT_VERSION } from './git/safegit.ts'
import type { JobEventV1, JobRequestV1 } from './contracts.ts'

function request(args: unknown, overrides: Partial<JobRequestV1> = {}): JobRequestV1 {
  const now = Date.now()
  const id = crypto.randomUUID()
  return {
    version: 1, jobId: id, idempotencyKey: id, sessionId: 'session', turnId: 'turn',
    nodeId: 'child', capabilityId: 'root', operation: WORKDIR_PROCESS_EXECUTE_OPERATION,
    args, createdAt: new Date(now).toISOString(),
    deadlineAt: new Date(now + 10_000).toISOString(), ...overrides,
  }
}

async function collect(events: AsyncIterable<JobEventV1>): Promise<JobEventV1[]> {
  const result: JobEventV1[] = []
  for await (const event of events) result.push(event)
  return result
}

async function until(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 300; i++) {
    if (predicate()) return
    await delay(10)
  }
  assert.fail('Condition not reached')
}

function setup(root: string) {
  const manager = new ProcessManager()
  const workdirs = [{ capabilityId: 'root', rootPath: root }]
  const local = new LocalExecutor(manager, 'child', [new CapabilityShell(workdirs), new CapabilityFilesystem(workdirs)], [])
  const requests: JobRequestV1[] = []
  const events: JobEventV1[] = []
  const remote = new RemoteExecutor({
    dispatchJob(job, callbacks) {
      requests.push(job)
      void (async () => {
        for await (const event of local.execute(job, new AbortController().signal)) {
          events.push(event)
          callbacks.onEvent(event)
        }
      })().catch(error => callbacks.onDisconnect(String(error)))
    },
    dispatchCancellation(_nodeId, jobId) { void local.cancel(jobId) },
  })
  return { manager, local, remote, requests, events }
}

test('capability shell rejects invalid wire args, absolute paths, traversal, node, env and display snapshots', async () => {
  for (const args of [
    null, { script: '' }, { script: 'echo ok', cwd: '/main/path' },
    { script: 'echo ok', cwd: 'C:\\main' }, { script: 'echo ok', cwd: 'C:relative' },
    { script: 'echo ok', cwd: '..\\outside' }, { script: 'echo ok', cwd: '../outside' },
    { script: 'echo ok', env: {} }, { script: 'echo ok', shell: 'node' },
    { script: 'echo ok', args: ['valid', 1] }, { script: 'echo ok', displayPathSnapshot: '/main' },
    { script: 'x'.repeat(40_000) },
  ]) assert.throws(() => parseWorkdirProcessArgs(args), /Remote shell requires/)
  await withTempWorkspace(async root => {
    const handler = new CapabilityShell([{ capabilityId: 'root', rootPath: root }])
    await mkdir(join(root, 'nested'))
    const prepared = await handler.prepareProcess(request({ script: 'echo ok', cwd: 'nested' }), new AbortController().signal)
    assert.equal(prepared.cwd, await realpath(join(root, 'nested')))
    await assert.rejects(() => handler.prepareProcess(request({ script: 'echo ok' }, { capabilityId: 'unknown' }), new AbortController().signal), /not granted/)
    await withTempWorkspace(async outside => {
      await symlink(outside, join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
      await assert.rejects(() => handler.prepareProcess(request({ script: 'echo ok', cwd: 'escape' }), new AbortController().signal), /outside the granted capability/)
    })
  })
})

test('workdir shell rejects an unregistered capability without spawning', async () => {
  await withTempWorkspace(async root => {
    const manager = new ProcessManager()
    const executor = new LocalExecutor(manager, 'child', [new CapabilityShell([{ capabilityId: 'root', rootPath: root }])])
    const events = await collect(executor.execute(request({ script: 'echo never' }, { capabilityId: 'unknown' }), new AbortController().signal))
    const terminal = events.at(-1)!
    assert.equal(terminal.type, 'rejected')
    assert('receipt' in terminal)
    assert.equal(terminal.receipt.reason?.code, 'capability-denied')
    assert.equal(manager.list().length, 0)
  })
})

test('trusted Child executes shell, file writes and reads without an approval roundtrip', async () => {
  await withTempWorkspace(async root => {
    const fixture = setup(root)
    const output = await executeRemoteShell({
      executor: fixture.remote, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn', signal: new AbortController().signal,
    }, { script: 'echo trusted-node' }, 10_000)
    assert.match(output, /trusted-node/)
    for (const [operation, args] of [
      ['filesystem.write', { path: 'trusted.txt', content: 'trusted-files' }],
      ['filesystem.read', { path: 'trusted.txt' }],
    ] as const) {
      const events = await collect(fixture.local.execute(request(args, { operation }), new AbortController().signal))
      assert.equal(events.at(-1)?.type, 'completed')
      if (operation === 'filesystem.read') assert(events.some(event => event.type === 'stdout' && event.chunk.includes('trusted-files')))
    }
    assert(fixture.requests.every(job => !Object.hasOwn(job, 'approval')))
  })
})

test('remote shell uses Child root and preserves stderr and nonzero receipts', async () => {
  await withTempWorkspace(async root => {
    const fixture = setup(root)
    const target = { executor: fixture.remote, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn', signal: new AbortController().signal }
    const script = process.platform === 'win32' ? 'cd & echo error-output 1>&2 & exit /b 7' : 'pwd; echo error-output >&2; exit 7'
    const pending = executeRemoteShell(target, { script }, 10_000)
    const result = await pending
    assert.match(result, /Error: remote exec failed/)
    assert.match(result, /exit code 7/)
    assert.match(result, /\[stderr\]/)
    assert(result.includes(root))
    assert(!JSON.stringify(fixture.requests[0]!.args).includes(root))
    assert.equal(fixture.manager.list().length, 0)
    const next = await executeRemoteShell(target, { script: 'echo granted' }, 10_000)
    assert.match(next, /granted/)
  })
})

test('remote shell timeout and cancellation await owned process cleanup and keep partial output', async () => {
  await withTempWorkspace(async root => {
    for (const mode of ['deadline', 'cancel'] as const) {
      const fixture = setup(root)
      const controller = new AbortController()
      const pending = executeRemoteShell({
        executor: fixture.remote, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn', signal: controller.signal,
      }, {
        script: process.platform === 'win32'
          ? 'echo before-wait & ping -n 30 127.0.0.1 > nul'
          : 'echo before-wait; sleep 30',
      }, mode === 'deadline' ? 5000 : 10_000)
      await until(() => fixture.manager.list().some(p => p.stdoutChunks.length > 0))
      const owned = fixture.manager.list()[0]!
      if (mode === 'cancel') controller.abort()
      const output = await pending
      assert.match(output, mode === 'deadline' ? /expired.*deadline-expired/ : /cancelled/)
      assert.match(output, /before-wait/)
      assert.notEqual(owned.exitedAt, undefined)
      assert.equal(fixture.manager.list().length, 0)
      assert.equal(fixture.events.filter(event => 'receipt' in event).length, 1)
      assert.equal((await owned.exitPromise).guardian?.reason, mode === 'deadline' ? 'deadline-expired' : 'cancelled')
    }
  })
})

test('workdir shell cancellation and expiration before admission never spawn', async () => {
  await withTempWorkspace(async root => {
    for (const mode of ['deadline', 'cancel'] as const) {
      const fixture = setup(root)
      const job = request({ script: 'echo never' }, mode === 'deadline' ? {
        createdAt: new Date(Date.now() - 2000).toISOString(),
        deadlineAt: new Date(Date.now() - 1000).toISOString(),
      } : {})
      const events = await collect(fixture.local.execute(job,
        mode === 'cancel' ? AbortSignal.abort() : new AbortController().signal))
      assert.deepEqual(events.map(event => event.type), ['accepted', mode === 'cancel' ? 'cancel-acknowledged' : 'expired'])
      assert.equal(fixture.manager.list().length, 0)
    }
  })
})

test('oversized shell output is split into bounded events and fails explicitly, never success-shaped truncation', async () => {
  await withTempWorkspace(async root => {
    const fixture = setup(root)
    const script = process.platform === 'win32'
      ? 'for /L %i in (1,1,10000) do @echo 0123456789abcdef0123456789abcdef'
      : 'i=0; while [ "$i" -lt 10000 ]; do echo 0123456789abcdef0123456789abcdef; i=$((i+1)); done'
    const pending = executeRemoteShell({
      executor: fixture.remote, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn', signal: new AbortController().signal,
    }, { script }, 10_000)
    assert.match(await pending, /Error: remote exec failed \[process-output-too-large\]/)
    for (const event of fixture.events) assert(Buffer.byteLength(JSON.stringify(event)) < 256 * 1024)
  })

})

test('POSIX foreground completion also terminates owned children with redirected stdio', {
  skip: process.platform === 'win32',
}, async () => {
  await withTempWorkspace(async root => {
    const fixture = setup(root)
    const pending = executeRemoteShell({
      executor: fixture.remote, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn', signal: new AbortController().signal,
    }, { script: '(sleep 1; echo leaked > leaked.txt) >/dev/null 2>&1 & echo done' }, 10_000)
    assert.match(await pending, /done/)
    await delay(1200)
    await assert.rejects(access(join(root, 'leaked.txt')), { code: 'ENOENT' })
  })
})

// Exercise the actual Child process route, not a Main-side environment fixture.
test('remote shell exposes the Child bundled safegit in native PATH', async t => {
  try { await access(requestedSafegitBinary()) } catch { t.skip('Host bundle not prepared'); return }
  await withTempWorkspace(async root => {
    const fixture = setup(root)
    const target = { executor: fixture.remote, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn', signal: new AbortController().signal }
    for (const shell of (process.platform === 'win32' ? ['cmd', 'powershell'] : ['sh']) as ('cmd' | 'powershell' | 'sh')[]) {
      const output = await executeRemoteShell(target, { script: 'safegit --version', shell }, 10_000)
      assert(output.includes(SAFEGIT_VERSION), output)
      assert(!output.startsWith('Error:'), output)
    }
    assert(!JSON.stringify(fixture.requests).includes('SHADOW_SAFEGIT_PATH'))
    assert.equal(fixture.manager.list().length, 0)
  })
})
