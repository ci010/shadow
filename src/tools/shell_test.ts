import assert, {
  deepEqual as assertEquals,
  match as assertMatch,
  rejects as assertRejects,
} from 'node:assert/strict'
import { test } from 'node:test'
import { cwd } from 'node:process'
import { createTempWorkspace } from '../testing/workspace.ts'
import type { ChildProcess } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import type { ExecutionContext } from '../agent/agent.ts'
import type {
  ManagedProcess,
  ManagedProcessStatus,
  ProcessManager,
} from '../agent/process-manager.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type {
  LocalProcessExecutor,
  ProcessExecuteArgsV1,
} from '../execution/executor.ts'
import { defaultManagedShell } from '../utils/exec-shell.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { CommandHandlerManager } from './commands/command-handler.ts'
import { ExecTool } from './shell.ts'

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve = (_value: T) => {}
  const promise = new Promise<T>((done) => resolve = done)
  return { promise, resolve }
}

function managedProcess(
  status: Promise<ManagedProcessStatus>,
  options: {
    stdout?: string
    stderr?: string
    pid?: number
  } = {},
): ManagedProcess & { killCount: () => number } {
  let kills = 0
  return {
    pid: options.pid ?? 4321,
    command: 'ignored',
    cwd: cwd(),
    shell: defaultManagedShell(),
    startedAt: new Date(),
    process: {
      kill: () => {
        kills++
        return true
      },
    } as unknown as ChildProcess,
    stdoutChunks: options.stdout
      ? [new TextEncoder().encode(options.stdout)]
      : [],
    stderrChunks: options.stderr
      ? [new TextEncoder().encode(options.stderr)]
      : [],
    exitPromise: status,
    killCount: () => kills,
  }
}

class RecordingExecutor implements LocalProcessExecutor {
  calls: ProcessExecuteArgsV1[] = []

  constructor(private process: ManagedProcess) {}

  startProcess(args: ProcessExecuteArgsV1): Promise<ManagedProcess> {
    this.calls.push(args)
    return Promise.resolve(this.process)
  }
}

class RecordingBackgroundTasks {
  calls = 0

  runPromiseTask(): string {
    this.calls++
    return 'background-123'
  }
}

function context(
  cwd: string,
  signal = new AbortController().signal,
): ExecutionContext {
  return {
    sessionId: 'session-1',
    physicalSessionId: 'physical-1',
    channel: 'test',
    chatId: 'chat-1',
    senderId: 'sender-1',
    senderName: 'Tester',
    isGroup: false,
    cwd,
    tools: undefined,
    signal,
  } as unknown as ExecutionContext
}

function execTool(
  workspace: string,
  executor: LocalProcessExecutor,
  backgroundTasks = new RecordingBackgroundTasks(),
): ExecTool {
  return new ExecTool(
    workspace,
    120_000,
    new CommandHandlerManager(),
    {} as ProcessManager,
    defaultManagedShell(),
    backgroundTasks as unknown as BackgroundTaskManager,
    executor,
  )
}

test('ExecTool foreground LocalExecutor parity: stdout, stderr, cwd, shell, args, and dotenv', async () => {
  const workspace = await createTempWorkspace()
  const sessionCwd = `${workspace}/session`
  await mkdir(sessionCwd)
  await writeFile(`${workspace}/.env`, 'PARITY_VALUE=from-dotenv\n')
  try {
    const process = managedProcess(
      Promise.resolve({ success: true, code: 0, signal: null }),
      { stdout: 'stdout-value', stderr: 'stderr-value' },
    )
    const executor = new RecordingExecutor(process)
    const result = await execTool(workspace, executor).execute({
      script: 'printf test',
      shell: defaultManagedShell(),
      args: ['one', 'two'],
      cwd: '.',
    }, context(sessionCwd))

    assertEquals(result, 'stdout-value\n[stderr]\nstderr-value')
    assertEquals(executor.calls, [{
      script: 'printf test',
      cwd: resolveAgentPath(workspace, sessionCwd, '.'),
      env: { PARITY_VALUE: 'from-dotenv' },
      shell: defaultManagedShell(),
      args: ['one', 'two'],
    }])
  } finally {
    await rm(workspace, { recursive: true })
  }
})

test('ExecTool foreground LocalExecutor parity: nonzero exit without output', async () => {
  const process = managedProcess(
    Promise.resolve({ success: false, code: 7, signal: null }),
  )
  const result = await execTool(cwd(), new RecordingExecutor(process))
    .execute({ script: 'exit 7' }, context(cwd()))

  assertEquals(result, 'Error: command exited with code 7')
})

test('ExecTool foreground LocalExecutor parity: timeout preserves process and partial output', async () => {
  const exit = deferred<ManagedProcessStatus>()
  const process = managedProcess(exit.promise, {
    stdout: 'partial-out',
    stderr: 'partial-err',
    pid: 9876,
  })
  const executor = new RecordingExecutor(process)
  const backgroundTasks = new RecordingBackgroundTasks()
  const result = await execTool(cwd(), executor, backgroundTasks).execute({
    script: 'long-running',
    timeout_ms: 1,
  }, context(cwd()))

  assertMatch(result, /^Process PID=9876 still running after /)
  assert(result.includes('partial-out\n[stderr]\npartial-err'))
  assert(result.includes('Background task ID: background-123'))
  assertEquals(backgroundTasks.calls, 1)
  assertEquals(process.killCount(), 0)
  exit.resolve({ success: true, code: 0, signal: null })
})

test('ExecTool timeout_ms=0 keeps the existing ProcessManager background path', async () => {
  const process = managedProcess(
    Promise.resolve({ success: true, code: 0, signal: null }),
    { pid: 2468 },
  )
  const executor = new RecordingExecutor(process)
  const backgroundTasks = new RecordingBackgroundTasks()
  let spawnCount = 0
  const processManager = {
    spawn: () => {
      spawnCount++
      return Promise.resolve(process)
    },
  } as unknown as ProcessManager
  const tool = new ExecTool(
    cwd(),
    120_000,
    new CommandHandlerManager(),
    processManager,
    defaultManagedShell(),
    backgroundTasks as unknown as BackgroundTaskManager,
    executor,
  )

  const result = await tool.execute(
    { script: 'background', timeout_ms: 0 },
    context(cwd()),
  )

  assert(result.includes('Process started. PID=2468'))
  assert(result.includes('Background task ID: background-123'))
  assertEquals(spawnCount, 1)
  assertEquals(executor.calls, [])
})

test('ExecTool foreground LocalExecutor parity: turn abort still rejects without killing', async () => {
  const exit = deferred<ManagedProcessStatus>()
  const process = managedProcess(exit.promise)
  const controller = new AbortController()
  const execution = execTool(cwd(), new RecordingExecutor(process)).execute(
    { script: 'long-running' },
    context(cwd(), controller.signal),
  )
  controller.abort(new Error('turn aborted'))

  await assertRejects(() => execution, { name: 'Error', message: /turn aborted/ })
  assertEquals(process.killCount(), 0)
  exit.resolve({ success: true, code: 0, signal: null })
})