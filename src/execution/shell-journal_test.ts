import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CapabilityShell } from './capability-shell.ts'
import { LocalExecutor } from './local-executor.ts'
import { ProcessManager } from './processes/manager.ts'
import { DURABLE_SHELL_OPERATION, JournaledShellExecutor, ShellJournal } from './shell-journal.ts'
import { RemoteExecutor } from './remote-executor.ts'
import { ProjectExecutor } from '../projects/executor.ts'
import { executeRemoteShell } from './remote-shell-client.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'
import type { JobEventV1, JobRequestV1 } from './contracts.ts'
import { persistGuardianResult } from './processes/guardian.ts'

function fixture(root: string, allowSpawn = true) {
  const journal = new ShellJournal(join(root, 'journal'))
  const manager = allowSpawn ? new ProcessManager() : { spawn: async () => assert.fail('Recovery must not start a command') }
  const local = new LocalExecutor(manager, 'child', [new CapabilityShell([{ capabilityId: 'root', rootPath: root }])],
    [], request => journal.processResultPath(request))
  return { journal, executor: new JournaledShellExecutor(local, journal) }
}

const target = (executor: ProjectExecutor) => ({
  executor, nodeId: 'child', capabilityId: 'root', sessionId: 'session', turnId: 'turn',
  executionKey: 'durable-tool-call', signal: new AbortController().signal,
})

test('durable shell replay survives both runtimes restarting and cannot cross project or request boundaries', async () => {
  await withTempWorkspace(async root => {
    const first = fixture(root)
    const args = { script: 'echo effect>>effects.txt' }
    await executeRemoteShell(target(new ProjectExecutor('project-a', first.executor)), args, 10000)
    const restarted = fixture(root, false)
    const main = new ProjectExecutor('project-a', restarted.executor)
    assert.match(await executeRemoteShell({ ...target(main), recovering: true }, args, 10000), /exit code 0/)
    assert.match(await executeRemoteShell(target(main), args, 10000), /exit code 0/, 'duplicate admission returns the stored receipt')
    assert.equal((await readFile(join(root, 'effects.txt'), 'utf8')).trim(), 'effect')
    await assert.rejects(executeRemoteShell({ ...target(new ProjectExecutor('project-b', restarted.executor)), recovering: true },
      args, 10000), ToolOutcomeUnknownError)
    await assert.rejects(executeRemoteShell({ ...target(main), recovering: true }, { script: 'echo different' }, 10000),
      /identity does not match/)
  })
})

test('lost terminal delivery reconciles on the existing Main without replay and settles pending project work', async () => {
  await withTempWorkspace(async root => {
    const child = fixture(root)
    let drop = true
    const remote = new RemoteExecutor({
      dispatchJob(request, callbacks) {
        void (async () => {
          for await (const event of child.executor.execute(request, new AbortController().signal)) {
            if ('receipt' in event && drop) callbacks.onDisconnect('Synthetic dropped terminal receipt')
            else callbacks.onEvent(event)
          }
        })().catch(error => callbacks.onDisconnect(String(error)))
      },
      dispatchCancellation(_nodeId, jobId) { void child.executor.cancel(jobId) },
    })
    const main = new ProjectExecutor('project', remote)
    const args = { script: 'echo effect>>effects.txt' }
    await assert.rejects(executeRemoteShell(target(main), args, 10000), ToolOutcomeUnknownError)
    assert.equal(main.hasPendingJobs, true)
    drop = false
    assert.match(await executeRemoteShell({ ...target(main), recovering: true }, args, 10000), /exit code 0/)
    assert.equal(main.hasPendingJobs, false)
    assert.equal((await readFile(join(root, 'effects.txt'), 'utf8')).trim(), 'effect')
  })
})

test('missing and interrupted admission records never fall back to starting the requested command', async () => {
  await withTempWorkspace(async root => {
    const { executor, journal } = fixture(root, false)
    const request: JobRequestV1 = {
      version: 1, jobId: 'job', idempotencyKey: 'key', nodeId: 'child', capabilityId: 'root', sessionId: 'session',
      turnId: 'turn', operation: DURABLE_SHELL_OPERATION, args: { script: 'echo must-not-start' },
      createdAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 10000).toISOString(),
    }
    const missing = await Array.fromAsync(executor.execute({ ...request, operation: 'workdir.process.reconcile' }, new AbortController().signal))
    assert.equal(missing.at(-1)?.type, 'failed')
    assert.equal(await journal.claim(request), true)
    const duplicate = await Array.fromAsync(executor.execute({ ...request, jobId: 'other-transport-attempt' }, new AbortController().signal))
    const terminal = duplicate.at(-1)!
    assert('receipt' in terminal)
    assert.equal(terminal.receipt.reason?.code, 'execution-outcome-unknown')
    assert.equal(terminal.receipt.jobId, 'other-transport-attempt')
  })
})

test('journal storage failure is explicit and occurs before any side effect', async () => {
  await withTempWorkspace(async root => {
    await writeFile(join(root, 'journal'), 'Not a directory')
    const { executor } = fixture(root, false)
    await assert.rejects(executeRemoteShell(target(new ProjectExecutor('project', executor)),
      { script: 'echo must-not-start' }, 10000), /could not be safely admitted/)
  })
})

test('a late independent receipt supersedes unknown diagnostics but never a known terminal outcome', async () => {
  await withTempWorkspace(async root => {
    const journal = new ShellJournal(join(root, 'journal'))
    const timestamp = new Date().toISOString()
    const request: JobRequestV1 = {
      version: 1, jobId: 'job', idempotencyKey: 'key', nodeId: 'child', capabilityId: 'root', sessionId: 'session',
      turnId: 'turn', operation: DURABLE_SHELL_OPERATION, args: { script: 'echo original' },
      createdAt: timestamp, deadlineAt: new Date(Date.now() + 10000).toISOString(),
    }
    await journal.claim(request)
    const failed: JobEventV1 = {
      version: 1, jobId: 'job', sequence: 0, timestamp, type: 'failed',
      receipt: { version: 1, jobId: 'job', nodeId: 'child', state: 'failed', finishedAt: timestamp,
        reason: { code: 'process-cleanup-failed', message: 'Outer guardian was killed', retryable: false } },
    }
    await journal.complete(request, [failed])
    assert.deepEqual(await journal.reconcile(request), { version: 1, outcome: 'known', events: [failed] })
    await persistGuardianResult(journal.processResultPath(request)!, {
      version: 1, startedAt: timestamp, finishedAt: timestamp, code: -1, signal: 'SIGKILL', reason: 'owner-lost',
      stdout: Buffer.from('original output').toString('base64'), stderr: '',
    })
    const recovered = await journal.reconcile(request)
    assert.equal(recovered.outcome, 'known')
    const terminal = recovered.events.at(-1)!
    assert.ok('receipt' in terminal && terminal.receipt.reason?.code === 'execution-interrupted')
    assert.equal(recovered.events[0].type, 'stdout')
    const completed: JobEventV1 = {
      version: 1, jobId: 'job', sequence: 0, timestamp, type: 'completed',
      receipt: { version: 1, jobId: 'job', nodeId: 'child', state: 'completed', exitCode: 0, finishedAt: timestamp },
    }
    await journal.complete(request, [completed])
    assert.deepEqual(await journal.reconcile(request), { version: 1, outcome: 'known', events: [completed] })
  })
})
