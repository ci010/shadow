import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { withTempWorkspace } from '../testing/workspace.ts'
import { fixtureProjectExecutor } from '../execution/test-fixtures.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { CapabilityShell } from '../execution/capability-shell.ts'
import { JournaledShellExecutor, ShellJournal } from '../execution/shell-journal.ts'
import { RemoteExecutor } from '../execution/remote-executor.ts'
import { assertExecutionSupported } from '../execution/workdir-contracts.ts'
import { createProjectScope } from '../projects/scope.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import { ExecTool } from './shell.ts'
import { SessionTools, Tools } from './registry.ts'
import { requireToolText } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'

for (const timeout of [0, 10]) {
  test(`remote OS timeout=${timeout} transfers ownership, streams bounded output, fails and notifies once`, { skip: process.platform === 'win32' }, async t => {
    await withTempWorkspace(async root => {
      const manager = new ProcessManager(), bus = new Bus(), inputs: string[] = [], requests: ExecutionRequestV2[] = []
      const events = new EventService(root, bus, async (sessionId, input) => {
        inputs.push(JSON.stringify(input)); return { status: 'accepted', sessionId, inputId: input.id }
      })
      const tasks = new BackgroundTaskManager(bus, events, createProjectScope('project'), root)
      const local = new LocalExecutor(manager, 'child', [new CapabilityShell([{ workdirId: 'root', rootPath: root }])], request => {
        assertExecutionSupported(request, [{ version: 2, nodeId: 'child', workdirId: 'root', displayName: 'root', online: true,
          support: { operations: ['workdir.process.execute-once', 'workdir.process.reconcile'], shell: { shells: ['sh'], untilExit: true, maxDeadlineMs: 120000 } } }], { operations: [] })
      })
      const journaled = new JournaledShellExecutor(local, new ShellJournal(join(root, 'journal')))
      let disconnect: ((reason: string) => void) | undefined
      const remote = new RemoteExecutor({
        dispatchJob(request, callbacks) {
          requests.push(request)
          disconnect = callbacks.onDisconnect
          void (async () => { for await (const event of journaled.execute(request, new AbortController().signal)) callbacks.onEvent(event) })().catch(error => callbacks.onDisconnect(String(error)))
        },
        dispatchCancellation(_node, job) { void journaled.cancel(job) },
      })
      const tool = new ExecTool(root, 120000, new CommandHandlerManager(), manager, 'sh', tasks)
      const registry = new Tools(root); registry.register(tool)
      const turn = new AbortController()
      const context = { projectId: 'project', sessionId: 'session', messageId: 'turn', toolCallId: 'call', signal: turn.signal,
        channel: 'test', chatId: 'test', tools: new SessionTools(registry, root),
        remoteWorkdir: { nodeId: 'child', workdirId: 'root', executor: fixtureProjectExecutor('project', remote) } } as unknown as ExecutionContext
      await writeFile(join(root, 'command.cjs'), 'console.log("live output"); setTimeout(() => { console.error("failure output"); process.exit(7) }, 1000)')
      try {
        const result = requireToolText(await tool.execute({ script: `"${process.execPath}" command.cjs`, timeout_ms: timeout }, context))
        assert.match(result, /Execution ID: bg:/)
        assert.equal((requests[0].args as { lifetime: string }).lifetime, 'until-exit')
        assert.equal(Date.parse(requests[0].deadlineAt) - Date.parse(requests[0].createdAt), 120000)
        turn.abort() // background is no longer owned by this turn
        const task = tasks.listTasks()[0]
        await t.waitFor(async () => assert.match(await tasks.getTaskOutput(task.id), /live output/), { timeout: 5000 })
        assert.equal(tasks.listTasks()[0].status, 'running')
        await t.waitFor(() => assert.equal(tasks.listTasks()[0].status, 'failed'), { timeout: 5000 })
        assert.match(await tasks.getTaskOutput(task.id), /failure output/)
        await t.waitFor(() => assert.equal(inputs.length, 1), { timeout: 5000 })
        // Recovery uses the same durable identity and never repeats side effects.
        const recovered = await tool.execute({ script: `"${process.execPath}" command.cjs` }, { ...context, signal: new AbortController().signal, recoveringToolCall: true })
        assert.match(requireToolText(recovered), /exit code 7/)
        assert.equal(requests[1].operation, 'workdir.process.reconcile')
        assert.equal(manager.list().length, 0)
        const cancelContext = { ...context, signal: new AbortController().signal, toolCallId: 'cancel-call' }
        await tool.execute({ script: 'echo cancellable; sleep 30', timeout_ms: 0 }, cancelContext)
        const cancelled = tasks.listTasks().find(task => task.status === 'running')!
        await t.waitFor(async () => assert.match(await tasks.getTaskOutput(cancelled.id), /\ncancellable/), { timeout: 5000 })
        assert.equal(await tasks.cancelTask(cancelled.id, cancelContext), 'cancelled')
        assert.equal(manager.list().length, 0)
        // Leaf calls use the deadline-enforced path and can never transfer to bg.
        const callTools = new SessionTools(registry, root); callTools.setExecutionScope('call', [])
        const before = tasks.listTasks().length
        const expired = await tool.execute({ script: 'echo foreground; sleep 30', timeout_ms: 1000 },
          { ...cancelContext, toolCallId: 'foreground-call', tools: callTools })
        assert.match(requireToolText(expired), /deadline-expired/)
        assert.equal(manager.list().length, 0)
        assert.equal(tasks.listTasks().length, before)
        const foregroundAbort = new AbortController()
        const foregroundPending = tool.execute({ script: 'echo abortable; sleep 30', timeout_ms: 10000 },
          { ...cancelContext, toolCallId: 'foreground-abort', tools: callTools, signal: foregroundAbort.signal })
        void foregroundPending.catch(() => {})
        await t.waitFor(() => assert(manager.list().length > 0), { timeout: 5000 })
        foregroundAbort.abort()
        await assert.rejects(foregroundPending, { name: 'AbortError' })
        assert.equal(manager.list().length, 0)
        await tool.execute({ script: 'echo disconnected; sleep 30', timeout_ms: 0 },
          { ...cancelContext, toolCallId: 'disconnect-call' })
        const disconnected = tasks.listTasks().find(task => task.status === 'running')!
        await t.waitFor(async () => assert.match(await tasks.getTaskOutput(disconnected.id), /\ndisconnected/), { timeout: 5000 })
        const dispatches = requests.length
        disconnect!('test transport lost')
        await t.waitFor(() => assert.equal(tasks.listTasks().find(task => task.id === disconnected.id)?.status, 'failed'), { timeout: 5000 })
        assert.match(await tasks.getTaskOutput(disconnected.id), /OUTCOME UNKNOWN/)
        assert.equal(requests.length, dispatches, 'No automatic redispatch after disconnect')

      } finally { await tasks.stop(); await events.stop(); bus.stopAll(); for (const p of manager.list()) await manager.terminate(p) }
    })
  })
}

test('until-exit Child ignores admission deadline after spawn; explicit cancellation confirms tree cleanup', { skip: process.platform === 'win32' }, async t => {
  await withTempWorkspace(async root => {
    const manager = new ProcessManager()
    const local = new LocalExecutor(manager, 'child', [new CapabilityShell([{ workdirId: 'root', rootPath: root }])], () => {})
    const now = Date.now(), id = crypto.randomUUID()
    const request: ExecutionRequestV2 = { version: 2, jobId: id, idempotencyKey: id, sessionId: 's', turnId: 't', nodeId: 'child', workdirId: 'root',
      operation: 'workdir.process.execute-once', args: { script: 'echo ready; sleep 30', lifetime: 'until-exit' },
      createdAt: new Date(now).toISOString(), deadlineAt: new Date(now + 1000).toISOString() }
    const received: string[] = []
    const completion = (async () => { for await (const event of local.execute(request, new AbortController().signal)) received.push(event.type) })()
    try {
      await t.waitFor(() => assert(received.includes('stdout')))
      await delay(1100)
      assert.equal((await local.getStatus(id))?.state, 'running')
      await local.cancel(id); await completion
      assert.equal((await local.getStatus(id))?.state, 'cancelled')
      assert.equal(manager.list().length, 0)
    } finally { for (const p of manager.list()) await manager.terminate(p) }
  })
})

test('until-exit negotiation rejects old Child before any execution', () => {
  const now = new Date().toISOString()
  assert.throws(() => assertExecutionSupported({ nodeId: 'child', workdirId: 'root', operation: 'workdir.process.execute-once', args: { script: 'never', lifetime: 'until-exit' }, createdAt: now, deadlineAt: now },
    [{ version: 2, nodeId: 'child', workdirId: 'root', displayName: 'root', online: true, support: { operations: ['workdir.process.execute-once'] } }], { operations: [] }), /explicit Child support/)
})
