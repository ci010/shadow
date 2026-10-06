import { ToolNoEffectError, isCompletedToolFailure, requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type { ProcessManager } from '../execution/processes/manager.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type { Executor } from '../execution/executor.ts'
import type { JobRequestV1 } from '../execution/contracts.ts'
import { ExecTool } from './shell.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import { SessionTools, Tools } from './registry.ts'
import { executeRemoteShell } from '../execution/remote-shell-client.ts'

function fixture(nodeOnly = false) {
  const requests: JobRequestV1[] = []
  const executor: Executor = {
    async *execute(request) {
      requests.push(request)
      yield {
        version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(),
        type: 'completed',
        receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', exitCode: 0, finishedAt: new Date().toISOString() },
      }
    },
    getStatus: async () => null,
    cancel: async () => { throw new Error('not expected') },
  }
  const tool = new ExecTool(
    process.cwd(), 120_000, new CommandHandlerManager(),
    { spawn: () => assert.fail('Must not spawn on Main') } as unknown as ProcessManager,
    'node', { runPromiseTask: () => assert.fail('No remote background task') } as unknown as BackgroundTaskManager,
    { startProcess: async () => assert.fail('Must not invoke Main executor') },
    nodeOnly,
  )
  const context = {
    sessionId: 'session', messageId: 'turn', cwd: 'C:\\Main\\never-resolve',
    defaultExecShell: 'powershell',
    signal: new AbortController().signal,
    remoteWorkdir: { nodeId: 'child', capabilityId: 'opaque', executor },
  } as unknown as ExecutionContext
  return { tool, context, requests }
}

test('Node-only exec rejects remote workdirs without dispatch or a local shell fallback', async () => {
  const { tool, context, requests } = fixture(true)
  for (const shell of [undefined, 'node', 'powershell']) {
    await assert.rejects(tool.execute({ script: 'must not run', shell }, context),
      error => error instanceof ToolNoEffectError && /Node-only exec|Only shell=node/.test(error.message))
  }
  assert.equal(requests.length, 0)
})

test('ExecTool remote path sends only capability-relative cwd and does not inherit Main shell or environment', async () => {
  const { tool, context, requests } = fixture()
  assert.equal(await tool.execute({ script: 'pwd', cwd: 'nested', args: ['one'] }, context), '(no output, exit code 0)')
  assert.equal(requests[0]?.operation, 'workdir.process.execute')
  assert.equal(requests[0]?.capabilityId, 'opaque')
  assert.deepEqual(requests[0]?.args, { script: 'pwd', cwd: 'nested', args: ['one'] })
  assert.equal(requests[0]?.turnId, 'turn')
})

test('ExecTool remote rejects unsupported execution modes and malformed inputs before dispatch', async () => {
  const { tool, context, requests } = fixture()
  for (const args of [
    { script: 'echo no', shell: 'node' },
    { script: 'echo no', timeout_ms: 0 }, { script: 'echo no', timeout_ms: -1 },
    { script: 'echo no', timeout_ms: '1' }, { script: 'echo no', timeout_ms: Infinity },
    { script: 'echo no', timeout_ms: 120001 }, { script: 'echo no', timeout_ms: 0.5 },
    { script: 'echo no', cwd: '/display/path' }, { script: 'echo no', args: [7] },
  ]) assert.match(requireToolText(await tool.execute(args, context)), /^Error:/)
  await assert.rejects(tool.execute({ script: 'echo no', shell: 'invalid' }, context), ToolNoEffectError)
  await assert.rejects(tool.execute({ shell: 'sh' }, context), ToolNoEffectError)
  const tools = new Tools(process.cwd())
  tools.register(tool)
  const sessionTools = new SessionTools(tools, process.cwd())
  sessionTools.setExecutionScope('call', [])
  assert.match(requireToolText(await tool.execute({ script: 'echo no' }, { ...context, tools: sessionTools })), /remote workdirs/)
  assert.equal(requests.length, 0)
})

test('remote helper never treats a missing or nonzero terminal receipt as success', async () => {
  const { context } = fixture()
  const executor: Executor = {
    ...context.remoteWorkdir!.executor,
    async *execute(request) {
      yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: 'stdout', chunk: 'misleading output' }
    },
  }
  const target = { ...context.remoteWorkdir!, executor, sessionId: 'session', turnId: 'turn', signal: context.signal }
  assert.match(await executeRemoteShell(target, { script: 'echo no' }, 1000), /^Error: remote exec incomplete/)
  for (const receipt of [
    { exitCode: 7 }, { jobId: 'wrong-job' }, { nodeId: 'wrong-child' }, { state: 'failed' as const },
  ]) {
    executor.execute = async function* (request) {
      yield {
        version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: 'completed',
        receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', exitCode: 0, finishedAt: new Date().toISOString(), ...receipt },
      }
    }
    assert.match(await executeRemoteShell(target, { script: 'echo no' }, 1000), /^Error:/)
  }
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(() => executeRemoteShell({ ...target, signal: controller.signal }, { script: 'echo no' }, 1000), { name: 'AbortError' })
})

test('real Tools and SessionTools dispatch remote exec in session/task modes but reject call mode', async () => {
  const { tool, context, requests } = fixture()
  const registry = new Tools(process.cwd())
  registry.register(tool)
  assert.equal(await registry.execute('exec', { script: 'pwd', timeout_ms: 60000 },
    { ...context, tools: new SessionTools(registry, process.cwd()) }), '(no output, exit code 0)')
  for (const mode of ['session', 'task'] as const) {
    const tools = new SessionTools(registry, process.cwd())
    tools.setExecutionScope(mode, [])
    assert.equal(await tools.execute('exec', { script: 'pwd', timeout_ms: 60000 }, { ...context, tools }), '(no output, exit code 0)')
  }
  assert.equal(requests.length, 3)
  const tools = new SessionTools(registry, process.cwd())
  tools.setExecutionScope('call', [])
  assert.match(requireToolText(await registry.execute('exec', { script: 'pwd', timeout_ms: 60000 }, { ...context, tools })), /remote workdirs/)
  assert.match(requireToolText(await tools.execute('exec', { script: 'pwd', timeout_ms: 60000 }, { ...context, tools })), /remote workdirs/)
  assert.equal(requests.length, 3)
})

test('only correlated normal remote process failures carry completion evidence', async () => {
  for (const variant of ['normal', 'signal', 'missing', 'foreign', 'unavailable', 'wrong-event'] as const) {
    const { tool, context } = fixture()
    context.remoteWorkdir!.executor.execute = async function* (request) {
      if (variant === 'missing') return
      yield {
        version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: variant === 'wrong-event' ? 'expired' : 'failed',
        receipt: { version: 1, jobId: variant === 'foreign' ? 'other-job' : request.jobId, nodeId: request.nodeId,
          state: 'failed', exitCode: 7, finishedAt: new Date().toISOString(),
          ...(variant === 'signal' ? { signal: 'SIGTERM' } : {}),
          reason: { code: variant === 'unavailable' ? 'remote-node-unavailable' : 'process-exit', message: 'Failed', retryable: false } },
      }
    }
    const result = await tool.execute({ script: 'fixture' }, context)
    assert.match(requireToolText(result), /^Error:/)
    assert.equal(isCompletedToolFailure(result), variant === 'normal', variant)
  }
})

test('registered remote exec keeps bounded output intact instead of spilling to a Main-only path', async () => {
  const { tool, context } = fixture()
  const output = 'remote output '.repeat(1100)
  const original = context.remoteWorkdir!.executor.execute
  context.remoteWorkdir!.executor.execute = async function* (request, signal) {
    yield { version: 1, jobId: request.jobId, sequence: 0, timestamp: new Date().toISOString(), type: 'stdout', chunk: output }
    yield* original(request, signal)
  }
  const registry = new Tools(process.cwd())
  registry.register(tool)
  assert.equal(await registry.execute('exec', { script: 'produce output' },
    { ...context, tools: new SessionTools(registry, process.cwd()) }), output)
})
