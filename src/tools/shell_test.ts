import assert, {
  deepEqual as assertEquals,
  match as assertMatch,
  rejects as assertRejects,
} from 'node:assert/strict'
import { after, test } from 'node:test'
import process from 'node:process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { setTimeout as delay } from 'node:timers/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import type { ChildProcess } from 'node:child_process'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import type { ExecutionContext } from './context.ts'
import type {
  ManagedProcess,
  ManagedProcessStatus,
  ProcessManager,
} from '../execution/processes/manager.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import type {
  LocalProcessExecutor,
  ProcessExecuteArgsV1,
} from '../execution/executor.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { CommandHandlerManager, type CommandContext } from './shell-commands/command-handler.ts'
import { ExecTool } from './shell.ts'
import { ProcessManager as RealProcessManager } from '../execution/processes/manager.ts'
import { SessionTools, Tools } from './registry.ts'
import { MAX_CALL_TIMEOUT_MS } from '../sessions/execution-scope.ts'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { registerEvalBridgeRoute } from '../script-runtime/bridge.ts'

const sandbox = await createTempWorkspace()
const cwd = () => sandbox
const previousPort = process.env.GATEWAY_PORT
const previousHost = process.env.GATEWAY_HOST
const bridgeApp = new Hono()
registerEvalBridgeRoute(bridgeApp)
const listening = Promise.withResolvers<number>()
const bridgeServer = serve({ fetch: bridgeApp.fetch, hostname: '127.0.0.1', port: 0 },
  address => listening.resolve(address.port))
process.env.GATEWAY_PORT = String(await listening.promise)
process.env.GATEWAY_HOST = '127.0.0.1'
after(async () => {
  if (previousPort === undefined) delete process.env.GATEWAY_PORT
  else process.env.GATEWAY_PORT = previousPort
  if (previousHost === undefined) delete process.env.GATEWAY_HOST
  else process.env.GATEWAY_HOST = previousHost
  await new Promise<void>((resolve, reject) => bridgeServer.close(error => error ? reject(error) : resolve()))
  await rm(sandbox, { recursive: true, force: true })
})

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
  options: Array<{ isolated?: boolean; signal?: AbortSignal } | undefined> = []

  constructor(private process: ManagedProcess) {}

  startProcess(args: ProcessExecuteArgsV1, options?: { isolated?: boolean; signal?: AbortSignal }): Promise<ManagedProcess> {
    this.calls.push(args)
    this.options.push(options)
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
  commandHandler = new CommandHandlerManager(),
): ExecTool {
  return new ExecTool(
    workspace,
    120_000,
    commandHandler,
    {} as ProcessManager,
    defaultManagedShell(),
    backgroundTasks as unknown as BackgroundTaskManager,
    executor,
  )
}

test('ExecTool command interception retains project and exact bot identity without spawning', async () => {
  const handler = new CommandHandlerManager()
  const intercepted: CommandContext[] = []
  handler.register('userlink', async context => {
    intercepted.push(context)
    return 'Handled'
  })
  const executor = new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null })))
  const tool = execTool(sandbox, executor, undefined, handler)
  const address = { projectId: 'org', botInstanceId: 'bot-a', platform: 'discord', conversationId: 'chat' }
  const result = await tool.execute({ script: 'userlink verify qq target' }, {
    ...context(sandbox), projectId: 'org', channelAddress: address, channel: 'discord', chatId: 'chat',
  })
  assert.equal(result, 'Handled')
  assert.equal(intercepted.length, 1)
  assert.equal(intercepted[0].projectId, 'org')
  assert.deepEqual(intercepted[0].channelAddress, address)
  assert.equal(executor.calls.length, 0)
})

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

function callContext(workspace: string, tool: ExecTool, signal = new AbortController().signal): ExecutionContext {
  const base = new Tools(workspace)
  base.register(tool)
  const tools = new SessionTools(base, workspace)
  tools.setExecutionScope('call', [])
  return { ...context(workspace, signal), tools }
}

test('call exec exposes foreground-only schema and rejects background, invalid limits and remote workdirs before spawn', async () => {
  const executor = new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null })))
  const background = new RecordingBackgroundTasks()
  const tool = execTool(sandbox, executor, background)
  const ctx = callContext(sandbox, tool)
  const schema = ctx.tools.getDefinitions()[0]!.function.parameters.properties.timeout_ms as Record<string, unknown>
  assertEquals(schema.default, MAX_CALL_TIMEOUT_MS)
  assertEquals(schema.minimum, 1)
  assertEquals(schema.maximum, MAX_CALL_TIMEOUT_MS)
  for (const timeout_ms of [0, -1, 0.5, NaN, Infinity, MAX_CALL_TIMEOUT_MS + 1, '1']) {
    assertMatch(await tool.execute({ script: 'must not spawn', timeout_ms }, ctx), /background execution is forbidden/)
    assertMatch(await ctx.tools.execute('exec', { script: 'must not spawn', timeout_ms }, ctx), /background execution is forbidden/)
  }
  assertMatch(await tool.execute({ script: 'remote must not fall back' }, {
    ...ctx, remoteWorkdir: { nodeId: 'remote', capabilityId: 'opaque', executor: {} as any },
  }), /remote workdirs/)
  assertEquals(executor.calls.length, 0)
  assertEquals(background.calls, 0)
})

test('call foreground cancellation waits for cleanup rather than releasing pending process ownership', async () => {
  const exit = deferred<ManagedProcessStatus>()
  const cleanup = deferred<void>()
  const managed = managedProcess(exit.promise)
  const executor = new RecordingExecutor(managed)
  const background = new RecordingBackgroundTasks()
  let terminated = false
  const manager = {
    terminate: async () => {
      terminated = true
      managed.process.kill()
      await cleanup.promise
      exit.resolve({ success: false, code: -1, signal: 'SIGTERM' })
      return exit.promise
    },
  } as unknown as ProcessManager
  const tool = new ExecTool(sandbox, 120_000, new CommandHandlerManager(), manager,
    defaultManagedShell(), background as unknown as BackgroundTaskManager, executor)
  const controller = new AbortController()
  const ctx = callContext(sandbox, tool, controller.signal)
  let settled = false
  const work = tool.execute({ script: 'held process' }, ctx)
  void work.then(() => { settled = true }, () => { settled = true })
  const rejection = assertRejects(work, /parent cancelled/)
  while (!executor.calls.length) await delay(1)
  controller.abort(new Error('parent cancelled'))
  while (!terminated) await delay(1)
  assertEquals(settled, false)
  assertEquals(executor.options[0]?.isolated, true)
  assertEquals(executor.options[0]?.signal?.aborted, true)
  cleanup.resolve()
  await rejection
  await ctx.tools.waitForForeground()
  assertEquals(managed.killCount(), 1)
  assertEquals(background.calls, 0)
})

test('call node exec cancels and joins unawaited foreground bridge work before returning', async () => {
  const workspace = await createTempWorkspace()
  const manager = new RealProcessManager()
  const background = new RecordingBackgroundTasks()
  const tool = new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager,
    defaultManagedShell(), background as unknown as BackgroundTaskManager)
  const controller = new AbortController()
  const pidFile = join(workspace, 'nested.pid')
  try {
    const module = join(workspace, 'nested-process.mjs')
    await writeFile(module, [
      'import {writeFileSync} from "node:fs";',
      `writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n'))
    const command = `"${process.execPath}" "${module}"`
    const script = [
      'import {existsSync} from "node:fs";',
      `void exec(${JSON.stringify({ script: command, timeout_ms: 30_000 })});`,
      `while (!existsSync(${JSON.stringify(pidFile)})) await new Promise(resolve => setTimeout(resolve, 10));`,
      'console.log("outer-finished");',
      'process.stdout.write("outer-finished\\n", () => process.exit(0));',
    ].join('\n')
    const result = await tool.execute({ shell: 'node', script, timeout_ms: 5000 },
      callContext(workspace, tool, controller.signal))
    assertEquals(JSON.parse(result).ok, true)
    assertMatch(result, /outer-finished/)
    assertEquals(manager.list(), [])
    assertEquals(background.calls, 0)
    const pid = Number(await readFile(pidFile, 'utf8'))
    assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH')
  } finally {
    controller.abort()
    for (const managed of manager.list()) await manager.terminate(managed)
    await rm(workspace, { recursive: true, force: true })
  }
})

for (const shell of [defaultManagedShell(), 'node'] as const) {
  test(`call foreground ${shell}: success leaves no managed process or background notification`, async () => {
    const workspace = await createTempWorkspace()
    const manager = new RealProcessManager()
    const background = new RecordingBackgroundTasks()
    const tool = new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager,
      defaultManagedShell(), background as unknown as BackgroundTaskManager)
    try {
      const script = shell === 'node' ? 'console.log("foreground-success")' : 'echo foreground-success'
      const result = await tool.execute({ shell, script }, callContext(workspace, tool))
      assertMatch(result, /foreground-success/)
      if (shell === 'node') assertEquals(JSON.parse(result).ok, true)
      assertEquals(manager.list(), [])
      assertEquals(background.calls, 0)
      if (shell === 'node') assertEquals(await readdir(join(workspace, '.eval')), [])
    } finally { await rm(workspace, { recursive: true, force: true }) }
  })

  for (const outcome of ['timeout', 'cancel'] as const) {
    test(`call foreground ${shell}: ${outcome} terminates the owned process tree before returning`, async () => {
      const workspace = await createTempWorkspace()
      const manager = new RealProcessManager()
      const background = new RecordingBackgroundTasks()
      const controller = new AbortController()
      const tool = new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager,
        defaultManagedShell(), background as unknown as BackgroundTaskManager)
      const ownerFile = join(workspace, 'owner.pid')
      const descendantFile = join(workspace, 'descendant.pid')
      const source = [
        'import { writeFileSync } from "node:fs";',
        'import { spawn } from "node:child_process";',
        `writeFileSync(${JSON.stringify(ownerFile)}, String(process.pid));`,
        'const ownedChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
        `writeFileSync(${JSON.stringify(descendantFile)}, String(ownedChild.pid));`,
        'process.stdout.write("foreground-partial\\n");',
        'await new Promise(() => { setInterval(() => {}, 1000) });',
      ].join('\n')
      let work: Promise<string> | undefined
      try {
        const module = join(workspace, 'process-fixture.mjs')
        await writeFile(module, source)
        const script = shell === 'node' ? source : `"${process.execPath}" "${module}"`
        work = tool.execute({ shell, script, timeout_ms: outcome === 'timeout' ? 1500 : 30_000 },
          callContext(workspace, tool, controller.signal))
        // Attach rejection handling before any cancellation or test assertion.
        const result = work.then(value => ({ value }), error => ({ error }))
        const deadline = Date.now() + 10_000
        while (!existsSync(descendantFile)) {
          assert(Date.now() < deadline, 'foreground fixture did not start')
          await delay(10)
        }

        if (outcome === 'cancel') controller.abort(new Error('parent cancelled'))
        const completed = await result
        if (outcome === 'cancel') {
          assert('error' in completed)
          assertMatch(String(completed.error), /parent cancelled/)
        } else {
          assert('value' in completed)
          assertMatch(completed.value, /timed out/)
          assertMatch(completed.value, /foreground-partial/)
          assert(!completed.value.includes('Background task ID'))
        }
        for (const file of [ownerFile, descendantFile]) {
          const pid = Number(await readFile(file, 'utf8'))
          assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH')
        }
        assertEquals(manager.list(), [])
        assertEquals(background.calls, 0)
        if (shell === 'node') assertEquals(await readdir(join(workspace, '.eval')), [])
      } finally {
        controller.abort()
        await work?.catch(() => {})
        for (const managed of manager.list()) await manager.terminate(managed)
        await rm(workspace, { recursive: true, force: true })
      }
    })
  }
}