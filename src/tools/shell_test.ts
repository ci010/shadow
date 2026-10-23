import { ToolNoEffectError, isCompletedToolFailure, requireToolText, type ToolResult } from './tool.ts'
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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import type { ExecutionContext } from './context.ts'
import type {
  ManagedProcess,
  ManagedProcessStatus,
  ProcessManager,
} from '../execution/processes/manager.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import type {
  LocalProcessExecutor,
  ProcessExecuteArgsV1,
} from '../execution/executor.ts'
import { defaultManagedShell } from '../execution/processes/shells.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { CommandHandlerManager, type CommandContext } from './shell-commands/command-handler.ts'
import { ExecTool } from './shell.ts'
import { resolveSessionLocations } from '../sessions/locality.ts'
import { localExecSafegitEnv } from '../execution/git/safegit.ts'
import { localExecSafegitAliasEnv } from '../execution/git/safegit-alias.ts'
import { ProcessManager as RealProcessManager } from '../execution/processes/manager.ts'
import { SessionTools, Tools } from './registry.ts'
import { MAX_CALL_TIMEOUT_MS } from '../sessions/execution-scope.ts'
import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'

const sandbox = await createTempWorkspace()
const cwd = () => sandbox
after(async () => {
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
  nodeOnly = false,
): ExecTool {
  return new ExecTool(
    workspace,
    120_000,
    commandHandler,
    {} as ProcessManager,
    defaultManagedShell(),
    backgroundTasks as unknown as BackgroundTaskManager,
    executor,
    nodeOnly,
  )
}

test('Node-only exec narrows discovery and rejects other shells before any dispatch', async () => {
  const executor = new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null })))
  const tool = execTool(sandbox, executor, undefined, undefined, true)
  assert.deepEqual(tool.parameters.properties.shell.enum, ['node'])
  assert.equal(tool.parameters.properties.shell.default, 'node')
  assert.doesNotMatch(JSON.stringify(tool.parameters), /PowerShell|powershell|pwsh|normally cmd/)
  for (const shell of ['cmd', 'sh', 'bash', 'git-bash', 'powershell', 'pwsh', 'invalid', null, 1]) {
    await assert.rejects(tool.execute({ shell, script: 'must not run', timeout_ms: 0 }, context(sandbox)),
      error => error instanceof ToolNoEffectError && /Only shell=node/.test(error.message))
  }
  assert.equal(executor.calls.length, 0)
  assert.equal(execTool(sandbox, executor).parameters.properties.shell.enum, undefined, 'Default surface is unchanged')
})

test('Node-only exec defaults to Node despite session preference and directly runs executable arguments', async () => {
  const workspace = await createTempWorkspace()
  const executor = new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null })))
  const tool = execTool(workspace, executor, undefined, undefined, true)
  const ctx = { ...callContext(workspace, tool), defaultExecShell: 'powershell' as const }
  const argument = '中文 "quotes" & | ; $HOME %PATH%'
  try {
    await writeFile(join(workspace, 'program with spaces.cjs'),
      'console.log(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd()}))')
    const response = await tool.execute({ script: `
      import { execFile } from 'node:child_process'
      import { promisify } from 'node:util'
      const result = await promisify(execFile)(process.execPath,
        ['program with spaces.cjs', ${JSON.stringify(argument)}], { encoding: 'utf8', shell: false })
      console.log(result.stdout)
    ` }, ctx)
    const result = JSON.parse(requireToolText(response))
    assert.equal(result.ok, true, requireToolText(response))
    assert.deepEqual(JSON.parse(result.stdout), { args: [argument], cwd: workspace })
    assert.equal(executor.calls.length, 0)
    assert.deepEqual(ctx.tools.getDefinitions().find(tool => tool.function.name === 'exec')?.function.parameters.properties.shell.enum, ['node'])
  } finally {
    await rm(workspace, { recursive: true, force: true })
  }
})

test('Node-only bridge cannot enable an OS shell through nested exec', async () => {
  const executor = new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null })))
  const tool = execTool(sandbox, executor, undefined, undefined, true)
  const response = await tool.execute({ script: `
    const rejected = await exec({ shell: 'powershell', script: 'must not run' })
    console.log(JSON.stringify(rejected))
  ` }, callContext(sandbox, tool))
  const result = JSON.parse(requireToolText(response))
  assert.equal(result.ok, true, requireToolText(response))
  assert.match(result.stdout, /Only shell=node/)
  assert.equal(executor.calls.length, 0)
})

test('Node-only native executable failures retain output and failed status', async () => {
  const tool = execTool(sandbox, new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null }))),
    undefined, undefined, true)
  const response = await tool.execute({ script: `
    import { execFile } from 'node:child_process'
    import { promisify } from 'node:util'
    try {
      await promisify(execFile)(process.execPath,
        ['-e', 'console.log("before-failure");console.error("native-failure");process.exit(7)'],
        { encoding: 'utf8', shell: false })
    } catch (error) {
      console.log(error.stdout)
      console.error(error.stderr)
      throw error
    }
  ` }, callContext(sandbox, tool))
  assert.equal(isCompletedToolFailure(response), true)
  const result = JSON.parse(requireToolText(response))
  assert.equal(result.ok, false)
  assert.match(result.stdout, /before-failure/)
  assert.match(result.stderr, /native-failure/)
  assert.match(result.error, /Command failed/)
})

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

    assertEquals(requireToolText(result), 'stdout-value\n[stderr]\nstderr-value')
    assertEquals(executor.calls, [{
      script: 'printf test',
      cwd: resolveAgentPath(workspace, sessionCwd, '.'),
      env: { ...await localExecSafegitAliasEnv(await localExecSafegitEnv({ PARITY_VALUE: 'from-dotenv' }), resolveSessionLocations(workspace, { sessionId: 'session-1' }).sessionDataDir), SHADOW_SESSION_DATA_DIR: resolveSessionLocations(workspace, { sessionId: 'session-1' }).sessionDataDir },
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

  assertEquals(requireToolText(result), [
    'Error: command exited with code 7',
    `Shell: ${process.shell}`,
    `Cwd: ${process.cwd}`,
    '[stdout]', '(empty)',
    '[stderr]', '(empty)',
  ].join('\n'))
  assert.equal(isCompletedToolFailure(result), true)
})

test('signal exits and missing exit codes do not attest completed failures', async () => {
  for (const status of [{ success: false, code: -1, signal: null }, { success: false, code: 7, signal: 'SIGTERM' as const }]) {
    const result = await execTool(cwd(), new RecordingExecutor(managedProcess(Promise.resolve(status))))
      .execute({ script: 'interrupted' }, context(cwd()))
    assert.equal(isCompletedToolFailure(result), false)
    if (status.signal) assert.match(requireToolText(result), /Signal: SIGTERM/)
  }
})

for (const mode of ['session', 'call'] as const) {
  for (const output of [
    { stdout: 'PASS before failure', stderr: 'assertion failed' },
    { stdout: '', stderr: 'assertion failed' },
    { stdout: 'PASS before failure', stderr: '' },
    { stdout: '', stderr: '' },
    { stdout: ' \n', stderr: '\t' },
  ]) {
    test(`exec ${mode} preserves failed status and diagnostics (${JSON.stringify(output)})`, async () => {
      const status = { success: false, code: 7, signal: null }
      const managed = managedProcess(Promise.resolve(status), output)
      managed.shell = 'sh'
      managed.cwd = join(sandbox, 'resolved-workdir')
      const tool = new ExecTool(sandbox, 120_000, new CommandHandlerManager(),
        { terminate: async () => status } as unknown as ProcessManager, defaultManagedShell(),
        new RecordingBackgroundTasks() as unknown as BackgroundTaskManager, new RecordingExecutor(managed))
      const ctx = mode === 'call' ? callContext(sandbox, tool) : context(sandbox)
      const result = await tool.execute({ script: 'synthetic failure' }, ctx)
      assert(typeof result !== 'string' && result.isError === true)
      assert.equal(isCompletedToolFailure(result), true)
      assert.equal(requireToolText(result), [
        'Error: command exited with code 7',
        'Shell: sh',
        `Cwd: ${managed.cwd}`,
        '[stdout]', output.stdout || '(empty)',
        '[stderr]', output.stderr || '(empty)',
      ].join('\n'))
    })
  }
}

for (const shell of [defaultManagedShell(), 'node'] as const) {
  for (const timeout_ms of [0, 1]) {
    test(`background ${shell} timeout=${timeout_ms} reports real failure with preserved output`, async t => {
      const manager = new RealProcessManager(), bus = new Bus()
      const inputs: string[] = []
      const events = new EventService(sandbox, bus, async (sessionId, input) => {
        inputs.push(JSON.stringify(input))
        return { status: 'accepted', sessionId, inputId: input.id }
      })
      const tasks = new BackgroundTaskManager(bus, events)
      const tool = new ExecTool(sandbox, 120_000, new CommandHandlerManager(), manager, defaultManagedShell(), tasks)
      const base = new Tools(sandbox)
      base.register(tool)
      const source = 'setTimeout(() => { console.log("PASS before failure"); console.log("SESSION_DATA=" + process.env.SHADOW_SESSION_DATA_DIR); console.error("assertion failed"); process.exit(7) }, 100)'
      const file = join(sandbox, `background-failure-${shell}-${timeout_ms}.cjs`)
      await writeFile(file, source)
      try {
        const result = await tool.execute({
          shell, timeout_ms, script: shell === 'node' ? source : `"${process.execPath}" "${file}"`,
        }, { ...context(sandbox), tools: new SessionTools(base, sandbox) })
        assertMatch(requireToolText(result), /Execution ID: bg:/)
        const task = tasks.listTasks()[0]
        await t.waitFor(() => assert.equal(tasks.listTasks()[0].status, 'failed'))
        const output = await tasks.getTaskOutput(task.id)
        assertMatch(output, /Status: failed/)
        assertMatch(output, /PASS before failure/)
        assertMatch(output, /assertion failed/)
        const expectedData = `SESSION_DATA=${resolveSessionLocations(sandbox, { sessionId: 'session-1' }).sessionDataDir}`
        assert(output.includes(shell === 'node' ? JSON.stringify(expectedData).slice(1, -1) : expectedData), output)
        if (shell !== 'node') {
          assert(output.includes(`Shell: ${shell}\nCwd: ${sandbox}`))
          assertMatch(output, /\[stdout\]\nPASS before failure/)
          assertMatch(output, /\[stderr\]\nassertion failed/)
        }
        assert.equal(tasks.listTasks()[0].status, 'failed')
        await t.waitFor(() => assert.equal(inputs.length, 1))
        assertMatch(inputs[0], /failed/)
      } finally {
        await tasks.stop()
        await events.stop()
        bus.stopAll()
        for (const managed of manager.list()) await manager.terminate(managed)
      }
    })
  }
}

test('PowerShell native pipelines preserve Unicode without changing the default shell', { skip: process.platform !== 'win32' }, async () => {
  const manager = new RealProcessManager()
  const input = String.fromCodePoint(0x4f60, 0x597d, 0x65e5, 0x672c, 0x1f3a7)
  const script = join(sandbox, 'unicode-pipe.cjs')
  await writeFile(script, "process.stdin.setEncoding('utf8');let text='';process.stdin.on('data',s=>text+=s);process.stdin.on('end',()=>console.log(JSON.stringify(text.trim())))")
  try {
    const tool = new ExecTool(sandbox, 120_000, new CommandHandlerManager(), manager,
      defaultManagedShell(), new RecordingBackgroundTasks() as unknown as BackgroundTaskManager)
    const result = await tool.execute({
      shell: 'powershell',
      script: `'${input}' | & '${process.execPath.replaceAll("'", "''")}' '${script.replaceAll("'", "''")}'`,
    }, context(sandbox))
    assertEquals(JSON.parse(requireToolText(result)), input)
    assertEquals(defaultManagedShell(), 'cmd')
    assertMatch(tool.parameters.properties!.shell.description!, /Select powershell\/pwsh explicitly/)
  } finally {
    for (const managed of manager.list()) await manager.terminate(managed)
  }
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

  assertMatch(requireToolText(result), /^Process PID=9876 still running after /)
  assert(requireToolText(result).includes('partial-out\n[stderr]\npartial-err'))
  assert(requireToolText(result).includes('Execution ID: bg:background-123'))
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

  assert(requireToolText(result).includes('Process started. PID=2468'))
  assert(requireToolText(result).includes('Execution ID: bg:background-123'))
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

function callContext(workspace: string, tool: ExecTool, signal = new AbortController().signal, base = new Tools(workspace)): ExecutionContext {
  base.register(tool)
  const tools = new SessionTools(base, workspace)
  tools.setExecutionScope('call', [])
  return { ...context(workspace, signal), tools }
}

test('node exec uses the shared TS runtime with native imports, args, cwd, env and bound project tools without HTTP', async () => {
  const workspace = await createTempWorkspace()
  const scope = createProjectScope('script-project')
  const runtime = new EvalBridgeRuntime({
    projectId: scope.projectId, scope,
  })
  const tool = execTool(workspace, new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null }))))
  const base = new Tools(workspace)
  const ctx = callContext(workspace, tool, undefined, base)
  const calls: ExecutionContext[] = []
  ctx.projectId = scope.projectId
  ctx.evalBridge = runtime
  ctx.toolCallId = 'outer-call'
  ctx.toolCallName = 'exec'
  base.register({
    name: 'fixture', description: 'fixture', parameters: { type: 'object', properties: {} },
    async execute(input, bound) {
      assert.equal(getProjectScope(), scope)
      calls.push(bound)
      return JSON.stringify({ input, sessionId: bound.sessionId })
    },
  })
  try {
    await writeFile(join(workspace, '.env'), 'SCRIPT_FIXTURE_VALUE=synthetic\n')
    const response = await tool.execute({
      shell: 'node', args: ['one', 'two'],
      script: [
        'import { basename } from "node:path";',
        'const number: number = 42;',
        'console.log(basename(process.cwd()), process.env.SCRIPT_FIXTURE_VALUE);',
        'console.log(JSON.stringify({ safegit: process.env.SHADOW_SAFEGIT_PATH }));',
        'export default async (args: string[]) => ({ number, args, calls: [await fixture({ value: 1 }), await fixture({ value: 2 })] });',
      ].join('\n'),
    }, ctx)
    const result = JSON.parse(requireToolText(response))
    assert.equal(result.ok, true, requireToolText(response))
    assert.match(result.stdout, /synthetic/)
    assert(result.stdout.includes(JSON.stringify({ safegit: (await localExecSafegitEnv({})).SHADOW_SAFEGIT_PATH })))
    assert.deepEqual(result.result, {
      number: 42, args: ['one', 'two'],
      calls: [{ input: { value: 1 }, sessionId: ctx.sessionId }, { input: { value: 2 }, sessionId: ctx.sessionId }],
    })
    assert.equal(calls.length, 2)
    assert(calls.every(call => call.projectId === scope.projectId && call.physicalSessionId === ctx.physicalSessionId))
    assert(calls.every(call => call.toolCallName === 'fixture' && call.toolCallId !== ctx.toolCallId))
    assert.notEqual(calls[0].toolCallId, calls[1].toolCallId)
    assert.equal(existsSync(join(workspace, '.eval')), false)
  } finally {
    await runtime.shutdown()
    scope.close()
    await rm(workspace, { recursive: true, force: true })
  }
})

test('node exec refuses missing project bindings and invalid finite timeouts before running source', async () => {
  const tool = execTool(sandbox, new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null }))))
  const ctx = { ...context(sandbox), tools: new SessionTools(new Tools(sandbox), sandbox), projectId: 'unbound' }
  const script = 'throw new Error("source must not execute")'
  for (const timeout_ms of [0, 100]) {
    assert.match(requireToolText(await tool.execute({ shell: 'node', script, timeout_ms }, ctx)), /injected eval bridge/)
  }
  for (const timeout_ms of [NaN, Infinity, -1, 0.5, 2_147_483_648]) {
    assert.match(requireToolText(await tool.execute({ shell: 'node', script, timeout_ms }, ctx)), /finite non-negative integer/)
  }
})

class ScriptBackgroundTasks extends RecordingBackgroundTasks {
  options?: Parameters<BackgroundTaskManager['runPromiseTask']>[0]
  completion?: Promise<string>

  override runPromiseTask(
    options?: Parameters<BackgroundTaskManager['runPromiseTask']>[0],
    completion?: Promise<string>,
  ): string {
    this.options = options
    this.completion = completion
    void completion?.catch(() => {})
    return super.runPromiseTask()
  }
}

for (const timeout_ms of [0, 50]) {
  test(`node exec background timeout=${timeout_ms} survives its turn and exposes live output, tools, cancellation and reaping`, async () => {
    const workspace = await createTempWorkspace()
    const background = new ScriptBackgroundTasks()
    const controller = new AbortController()
    const tool = execTool(workspace, new RecordingExecutor(managedProcess(Promise.resolve({ success: true, code: 0, signal: null }))), background)
    const base = new Tools(workspace)
    const tools = new SessionTools(base, workspace)
    let calls = 0
    base.register({
      name: 'heartbeat', description: '', parameters: { type: 'object', properties: {} },
      async execute(_input, ctx) {
        ctx.signal.throwIfAborted()
        calls++
        return 'alive'
      },
    })
    const ownerFile = join(workspace, 'owner.pid')
    const childFile = join(workspace, 'child.pid')
    try {
      const response = await tool.execute({
        shell: 'node', timeout_ms,
        script: [
          'import { writeFileSync } from "node:fs";',
          'import { spawn } from "node:child_process";',
          `writeFileSync(${JSON.stringify(ownerFile)}, String(process.pid));`,
          'const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "inherit" });',
          `writeFileSync(${JSON.stringify(childFile)}, String(child.pid));`,
          'setInterval(async () => console.log(await heartbeat({})), 5);',
        ].join('\n'),
      }, { ...context(workspace, controller.signal), tools })
      assert.match(requireToolText(response), /Execution ID: bg:/)
      assert.equal(background.calls, 1)
      controller.abort(new Error('turn ended'))
      const deadline = Date.now() + 10_000
      while (calls < 140 || !String(await background.options?.observe?.()).includes('alive')) {
        assert(Date.now() < deadline, 'background script did not stay alive and call its tools')
        await delay(20)
      }
      await background.options?.onCancel?.('cancel')
      await assertRejects(background.completion!, /abort|cancel|terminated/i)
      for (const file of [ownerFile, childFile]) {
        const pid = Number(await readFile(file, 'utf8'))
        assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH')
      }
      assert.equal(existsSync(join(workspace, '.eval')), false)
    } finally {
      await background.options?.onCancel?.('cancel')
      await background.completion?.catch(() => {})
      await rm(workspace, { recursive: true, force: true })
    }
  })
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
    assertMatch(requireToolText(await tool.execute({ script: 'must not spawn', timeout_ms }, ctx)), /background execution is forbidden/)
    assertMatch(requireToolText(await ctx.tools.execute('exec', { script: 'must not spawn', timeout_ms }, ctx)), /background execution is forbidden/)
  }
  assertMatch(requireToolText(await tool.execute({ script: 'remote must not fall back' }, {
    ...ctx, remoteWorkdir: { nodeId: 'remote', capabilityId: 'opaque', executor: {} as any },
  })), /remote workdirs/)
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
    assertEquals(JSON.parse(requireToolText(result)).ok, true)
    assertMatch(requireToolText(result), /outer-finished/)
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
      assertMatch(requireToolText(result), /foreground-success/)
      if (shell === 'node') assertEquals(JSON.parse(requireToolText(result)).ok, true)
      assertEquals(manager.list(), [])
      assertEquals(background.calls, 0)
      if (shell === 'node') assertEquals(existsSync(join(workspace, '.eval')), false)
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
      let work: Promise<ToolResult> | undefined
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
          assertMatch(requireToolText(completed.value), /timed out/)
          assertMatch(requireToolText(completed.value), /foreground-partial/)
          assert(!requireToolText(completed.value).includes('Execution ID: bg:'))
        }
        for (const file of [ownerFile, descendantFile]) {
          const pid = Number(await readFile(file, 'utf8'))
          assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH')
        }
        assertEquals(manager.list(), [])
        assertEquals(background.calls, 0)
        if (shell === 'node') assertEquals(existsSync(join(workspace, '.eval')), false)
      } finally {
        controller.abort()
        await work?.catch(() => {})
        for (const managed of manager.list()) await manager.terminate(managed)
        await rm(workspace, { recursive: true, force: true })
      }
    })
  }
}

test('local OS and Node children receive the explicit host safegit override ahead of dotenv without mutating the host', async () => {
  const workspace = await createTempWorkspace()
  const previous = process.env.SHADOW_SAFEGIT_PATH
  const binary = join(workspace, 'explicit-safegit')
  const manager = new RealProcessManager()
  const scope = createProjectScope('safegit-env-project')
  const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
  const tool = new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager,
    defaultManagedShell(), new RecordingBackgroundTasks() as unknown as BackgroundTaskManager)
  try {
    process.env.SHADOW_SAFEGIT_PATH = binary
    await writeFile(join(workspace, '.env'), 'SHADOW_SAFEGIT_PATH=must-not-replace-host\n')
    const ctx = callContext(workspace, tool)
    ctx.projectId = scope.projectId
    ctx.evalBridge = runtime
    const shell = process.platform === 'win32' ? 'cmd' : 'sh'
    const os = await tool.execute({ shell, script: process.platform === 'win32'
      ? 'echo %SHADOW_SAFEGIT_PATH%' : 'printf "%s" "$SHADOW_SAFEGIT_PATH"' }, ctx)
    assert.equal(requireToolText(os).trim(), binary)
    const node = JSON.parse(requireToolText(await tool.execute({ shell: 'node',
      script: 'export default () => process.env.SHADOW_SAFEGIT_PATH' }, ctx)))
    assert.equal(node.ok, true)
    assert.equal(node.result, binary)
    assert.equal(process.env.SHADOW_SAFEGIT_PATH, binary)
  } finally {
    if (previous === undefined) delete process.env.SHADOW_SAFEGIT_PATH
    else process.env.SHADOW_SAFEGIT_PATH = previous
    await runtime.shutdown()
    scope.close()
    await rm(workspace, { recursive: true, force: true })
  }
})


test('local OS and Node use current logical session data despite inherited cwd and dotenv, without host mutation', async () => {
  const workspace = await createTempWorkspace()
  const before = process.env.SHADOW_SESSION_DATA_DIR
  const manager = new RealProcessManager()
  const scope = createProjectScope('session-env-project')
  const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
  const tool = new ExecTool(workspace, 120_000, new CommandHandlerManager(), manager,
    defaultManagedShell(), new RecordingBackgroundTasks() as unknown as BackgroundTaskManager)
  try {
    await writeFile(join(workspace, '.env'), 'SHADOW_SESSION_DATA_DIR=wrong-dotenv-owner\n')
    const owner = resolveSessionLocations(workspace, { sessionId: 'web:owner' }).sessionDataDir
    await mkdir(owner, { recursive: true })
    for (const mode of ['call', 'session'] as const) {
      const ctx = callContext(workspace, tool)
      if (mode === 'session') ctx.tools.setExecutionScope('session', [])
      Object.assign(ctx, { sessionId: `sub-current-${mode}`, physicalSessionId: 'different-segment',
        workspaceRoot: 'web:owner', cwd: owner, projectId: scope.projectId, evalBridge: runtime })
      const expected = resolveSessionLocations(workspace, { sessionId: ctx.sessionId }).sessionDataDir
      assert.notEqual(expected, owner)
      const shell = process.platform === 'win32' ? 'cmd' : 'sh'
      const os = await tool.execute({ shell, script: process.platform === 'win32'
        ? 'echo %SHADOW_SESSION_DATA_DIR%' : 'printf "%s" "$SHADOW_SESSION_DATA_DIR"' }, ctx)
      assert.equal(requireToolText(os).trim(), expected)
      const nodeText = requireToolText(await tool.execute({ shell: 'node',
        script: 'export default () => ({ data: process.env.SHADOW_SESSION_DATA_DIR, cwd: process.cwd() })' }, ctx))
      assert(nodeText.startsWith('{'), nodeText)
      const node = JSON.parse(nodeText)
      assert.equal(node.ok, true)
      assert.deepEqual(node.result, { data: expected, cwd: owner })
      assert.equal(process.env.SHADOW_SESSION_DATA_DIR, before)
    }
  } finally {
    await runtime.shutdown()
    scope.close()
    await rm(workspace, { recursive: true, force: true })
  }
})
