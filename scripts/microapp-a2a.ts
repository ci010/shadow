import { projectStoragePath } from '../src/utils/data-paths.ts'
import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { z } from 'zod'
import { ConfigSchema } from '../src/config/schema.ts'
import { DEFAULT_COPILOT_MODEL } from '../src/config/defaults.ts'
import { projectPaths } from '../src/projects/contracts.ts'
import { startMainRuntime } from '../src/runtime/main/start.ts'
import { providerPlugin } from '../src/providers/routes.ts'
import { CopilotProvider } from '../src/providers/copilot.ts'
import { writePrivateFile } from '../src/config/store.ts'
import { terminateProcessTree, type ManagedProcessStatus } from '../src/execution/processes/manager.ts'
import { reserveAppPort } from '../src/microapps/ports.ts'
import { appId, appRecordSchema, revisionId, type AppRecord } from '../src/microapps/contracts.ts'
import { MicroAppStore } from '../src/microapps/store.ts'
import { projectWorkOverviewSchema } from '../src/projects/work-overview.ts'
import { exportAcceptanceRecovery } from './microapp-acceptance-recovery.ts'
import { AcceptanceTimeline, acceptanceTaskTerminal, stopAcceptanceCreation } from './microapp-acceptance-timeline.ts'

const root = fileURLToPath(new URL('..', import.meta.url))
export const AUDIO_ACCEPTANCE_PROMPT = `我想要一个能重复使用的小工具：我输入中文，按按钮后用 LLM 翻译成自然的日语，然后用本地 TTS 合成日语音频，可以试听和下载 WAV。最好以后能接 VRChat 虚拟麦克风，不过这一轮先做好 WAV，不安装驱动、不改默认音频设备、不向 VRChat 播放。界面要有明确的忙碌、错误和取消状态。关闭再打开、重启后还能用，不能每次都让 agent 重新执行一串命令。
这轮环境是全新的，不能读取或修改这轮工作目录之外的用户文件、旧会话、记忆或其它项目。可以使用已安装的 Python/Node 和公开依赖，新增下载总量上限 1 GiB、测试产物及资源总量上限 4 GiB。先验证依赖，再下载资源；遇到需要额外权限或超出预算的行为先停下说明。先实现并交付可打开的入口；如果需要我审核授权，如实指出，不绕过审核。`

async function runtimeChild(directory: string) {
  process.chdir(directory)
  const configPath = join(directory, 'runtime.config.json')
  const config = ConfigSchema.parse(JSON.parse(await readFile(configPath, 'utf8')))
  const launchCredential = process.env.SHADOW_TEST_OWNER
  delete process.env.SHADOW_TEST_OWNER
  const runtime = await startMainRuntime(config, { configPath, localNodeId: 'microapp-acceptance',
    gateway: { host: '127.0.0.1', port: Number(process.env.SHADOW_TEST_PORT), launchCredential } })
  process.once('message', async message => {
    if (message !== 'shutdown') return
    try { await runtime.shutdown(); process.exitCode = 0 }
    catch (error) { console.error('Test runtime shutdown failed:', error instanceof Error ? error.name : 'unknown'); process.exitCode = 1 }
    finally { process.disconnect?.() }
  })
  await runtime.ready
  delete process.env.SHADOW_TEST_CALLER
  delete process.env.SHADOW_TEST_PORT
  process.send?.('ready')
}

export async function loadAcceptancePrompt(path?: string): Promise<string> {
  if (!path) return AUDIO_ACCEPTANCE_PROMPT
  const prompt = (await readFile(path, 'utf8')).trim()
  if (!prompt || Buffer.byteLength(prompt, 'utf8') > 64 * 1024) throw new Error('Acceptance prompt must contain 1–65536 UTF-8 bytes')
  return prompt
}

export function acceptanceCallBudget(value = '100'): number {
  const count = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(count) || count < 1 || count > 100) {
    throw new Error('Acceptance max-calls must be an integer from 1 to 100')
  }
  return count
}

export function acceptanceBudgetError(calls: number, maxCalls: number, deadline?: number, now = Date.now()) {
  if (deadline !== undefined && now >= deadline) return 'live_test_deadline_exhausted'
  if (calls >= maxCalls) return 'live_test_call_budget_exhausted'
  return undefined
}

export function acceptanceRequestRejection(timeline: AcceptanceTimeline | undefined, calls: number, maxCalls: number) {
  const phaseError = timeline ? timeline.modelError() : 'live_test_not_started'
  if (phaseError) return { error: phaseError, status: 403 as const }
  const error = acceptanceBudgetError(calls, maxCalls)
  return error ? { error, status: 429 as const } : undefined
}

export function acceptanceRuntimeDirectory(output: string, runtimeRoot?: string): string {
  const artifacts = resolve(output)
  if (runtimeRoot === undefined) return join(artifacts, 'runtime')
  const directory = resolve(runtimeRoot)
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child)
    return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
  }
  if (contains(directory, artifacts) || contains(artifacts, directory)) {
    throw new Error('Explicit runtime-root and artifact output must be separate, non-nested directories')
  }
  return directory
}

export class AcceptanceControlError extends Error {}

export async function acceptanceOperatorAttempt(id: string, action: string, execute: () => Promise<void>) {
  try {
    await execute()
    return { id, action, done: true as const }
  } catch (error) {
    if (!(error instanceof AcceptanceControlError)) throw error
    return { id, action, done: false as const, error: error.message }
  }
}

const acceptanceTaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: z.object({ state: z.string().min(1) }).passthrough(),
}).passthrough()

export function acceptanceMessage(text: unknown, previous?: unknown) {
  if (typeof text !== 'string' || !text.trim() || Buffer.byteLength(text, 'utf8') > 64 * 1024) {
    throw new Error('Acceptance message must contain 1–65536 UTF-8 bytes')
  }
  const target = previous === undefined ? undefined : acceptanceTaskSchema.parse(previous)
  const state = target?.status.state
  if (target && !['TASK_STATE_INPUT_REQUIRED', 'TASK_STATE_COMPLETED', 'TASK_STATE_FAILED',
    'TASK_STATE_CANCELED', 'TASK_STATE_REJECTED'].includes(target.status.state)) {
    throw new Error('Wait for input-required or a terminal task before sending an operator message')
  }
  const kind = !target ? 'initial' : state === 'TASK_STATE_INPUT_REQUIRED' ? 'answer' : 'followup'
  return {
    kind,
    question: kind === 'answer' ? target?.status.message : undefined,
    message: {
      messageId: randomUUID(), role: 'ROLE_USER' as const, parts: [{ text }],
      ...(target ? { contextId: target.contextId } : {}),
      ...(target && kind === 'answer' ? { taskId: target.id } : {}),
    },
  }
}

export function acceptanceProviderFailure(error: unknown) {
  const codes = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
    'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET',
    'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'ABORT_ERR'])
  const chain: Array<{ name: string; code?: string }> = []
  for (let depth = 0; error instanceof Error && depth < 4; depth++, error = error.cause) {
    const name = ['Error', 'TypeError', 'AbortError', 'TimeoutError', 'AggregateError', 'CopilotAuthError'].includes(error.name)
      ? error.name : 'OtherError'
    const code = 'code' in error && typeof error.code === 'string' && codes.has(error.code) ? error.code : undefined
    chain.push({ name, ...(code ? { code } : {}) })
  }
  return { chain }
}

export async function writeAcceptanceArtifact(path: string, content: string, write = writePrivateFile) {
  for (let attempt = 0; ; attempt++) {
    try { write(path, content); return }
    catch (error) {
      const retryable = error instanceof Error && 'syscall' in error && error.syscall === 'rename'
        && 'code' in error && ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code))
      if (!retryable || attempt === 4) throw error
      console.warn(`[microapp-acceptance] Artifact rename contention; retry ${attempt + 1}/4 (${error.code}).`)
      await delay(50 * 2 ** attempt)
    }
  }
}

export async function exportAcceptanceBundles(home: string, output: string) {
  const records: AppRecord[] = []
  const store = new MicroAppStore(home)
  const entries = await readdir(store.root, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  })
  for (const entry of entries) {
    if (!entry.isDirectory() || !appId.safeParse(entry.name).success) continue
    const record = appRecordSchema.parse(JSON.parse(await readFile(join(store.root, entry.name, 'record.json'), 'utf8')))
    if (record.id !== entry.name) throw new Error('Test app record identity mismatch')
    const bundle = await store.bundle(record)
    await mkdir(join(output, 'bundles'), { recursive: true })
    writePrivateFile(join(output, 'bundles', `${record.id}.json`), JSON.stringify(bundle))
    records.push(record)
  }
  return records
}

export function acceptanceRuntimeEnv(directory: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const profile = join(directory, 'profile')
  const env: NodeJS.ProcessEnv = { GITHUB_COPILOT_TOKEN_DIR: join(directory, 'empty-auth') }
  for (const [key, value] of Object.entries(inherited)) {
    if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL)$/i.test(key)) env[key] = value
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_STATE_HOME']) env[key] = profile
  for (const [key, name] of Object.entries({
    npm_config_cache: 'npm-cache', npm_config_prefix: 'npm-prefix', npm_config_userconfig: 'empty.npmrc',
    PIP_CACHE_DIR: 'pip-cache', UV_CACHE_DIR: 'uv-cache', HF_HOME: 'huggingface',
    TORCH_HOME: 'torch', PYTHONUSERBASE: 'python-user', NUGET_PACKAGES: 'nuget',
  })) env[key] = join(profile, name)
  return env
}

export async function runAcceptance(output: string, prompt: string, testBoundaries?: string, maxCalls = 100, runtimeRoot?: string, nodeOnly = false) {
  if (process.env.SHADOW_MICROAPP_LIVE !== '1') throw new Error('Set SHADOW_MICROAPP_LIVE=1 to authorize a live, potentially billable model test')
  maxCalls = acceptanceCallBudget(String(maxCalls))
  const directory = acceptanceRuntimeDirectory(output, runtimeRoot)
  await mkdir(output)
  await mkdir(directory)
  const provider = new CopilotProvider()
  const model = process.env.SHADOW_MICROAPP_MODEL ?? DEFAULT_COPILOT_MODEL
  try {
    const models = await provider.listModels()
    if (!models.includes(model)) throw new Error(`Model ${model} is unavailable through the standard Copilot login; no test session was created`)
  } catch (error) {
    await rm(directory, { recursive: true, force: true })
    throw error
  }
  const secrets = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]
  const [proxyToken, ownerToken, callerToken] = secrets
  const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[TEST_CREDENTIAL]'), value)
  const artifact = async (name: string, value: unknown) => writeAcceptanceArtifact(join(output, name), redact(JSON.stringify(value, null, 2)))
  let calls = 0
  let timeline: AcceptanceTimeline | undefined
  let approvalGate: Promise<void> | undefined
  const chat = provider.chat.bind(provider)
  provider.chat = async (...args) => {
    const [messages, tools, options] = args
    try {
      if (!timeline) throw new Error('Acceptance creation has not started')
      const active = timeline
      return await active.model(signal => chat(tools.length
        ? active.prompt(messages, maxCalls - calls + 1) : messages, tools, { ...options, signal }), options.signal)
    }
    catch (error) {
      await artifact('provider-failure.json', { call: calls, at: new Date().toISOString(), ...acceptanceProviderFailure(error) })
      throw error
    }
  }
  const proxyApp = new Hono()
  proxyApp.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${proxyToken}`) return c.json({ error: 'unauthorized' }, 401)
    if (c.req.method === 'POST') {
      const body = await c.req.json()
      if (body.model !== model) return c.json({ error: 'test_model_not_allowed' }, 403)
      await approvalGate
      const rejection = acceptanceRequestRejection(timeline, calls, maxCalls)
      if (rejection) return c.json({ error: rejection.error }, rejection.status)
      calls++
    }
    return next()
  })
  providerPlugin(provider)(proxyApp)
  const listening = Promise.withResolvers<number>()
  const proxy = serve({ fetch: proxyApp.fetch, hostname: '127.0.0.1', port: 0 }, info => listening.resolve(info.port))
  proxy.once('error', listening.reject)
  let child: ChildProcess | undefined, logs = '', state = 'starting'
  let childClosed: Promise<ManagedProcessStatus> | undefined
  let base = '', task: z.infer<typeof acceptanceTaskSchema> | undefined
  const ownerRequest = async (path: string, body?: unknown) => {
    const response = await fetch(base + '/projects/default/api' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    const value = await response.json()
    if (!response.ok) {
      const failure = z.object({ error: z.string(), message: z.string().optional() }).parse(value)
      const message = `Owner operation failed: ${response.status} ${failure.error}${failure.message ? `: ${failure.message}` : ''}`
      if ([400, 403, 404, 409].includes(response.status)) throw new AcceptanceControlError(message)
      throw new Error(message)
    }
    return value
  }
  const owner = (path: string, body?: unknown) => ownerRequest('/microapps' + path, body)
  const rpc = async (method: string, params: unknown) => {
    const response = await fetch(base + '/projects/default/a2a', {
      method: 'POST', headers: { Authorization: `Bearer ${callerToken}`, 'A2A-Version': '1.0', 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: randomUUID(), method, params }), signal: AbortSignal.timeout(35_000),
    })
    const value = await response.json()
    if (!response.ok || value.error) throw new Error(`A2A ${method} failed: ${JSON.stringify(value.error ?? response.status)}`)
    return value.result
  }
  const conversation: Array<ReturnType<typeof acceptanceMessage> & {
    attemptedAt: string; callsBefore: number;
    accepted?: { at: string; calls: number; taskId: string; contextId: string; status: unknown };
  }> = []
  const send = async (text: unknown, previous?: unknown) => {
    const input: (typeof conversation)[number] = {
      ...acceptanceMessage(text, previous), attemptedAt: new Date().toISOString(), callsBefore: calls,
    }
    conversation.push(input)
    await artifact('conversation.json', conversation)
    const result = await rpc('SendMessage', {
      message: input.message, configuration: { returnImmediately: true },
    })
    const accepted = acceptanceTaskSchema.parse(result.task)
    if ((input.message.taskId && accepted.id !== input.message.taskId)
      || (input.message.contextId && accepted.contextId !== input.message.contextId)) {
      throw new Error('A2A continuation identity mismatch; do not resend automatically')
    }
    input.accepted = { at: new Date().toISOString(), calls, taskId: accepted.id,
      contextId: accepted.contextId, status: accepted.status }
    await artifact('conversation.json', conversation)
    return accepted
  }
  const home = join(directory, 'home'), project = projectPaths(home, 'default')
  try {
    const proxyPort = await listening.promise, port = await reserveAppPort()
    base = `http://127.0.0.1:${port}`
    await mkdir(project.home, { recursive: true })
    await mkdir(join(directory, 'profile'), { recursive: true })
    await writeFile(join(directory, 'profile', 'empty.npmrc'), '')
    const config = {
      agent: { workspace: home, model: `${model}@openai`, sessionStorage: 'jsonl', maxToolIterations: 80 },
      providers: { openai: { apiKey: proxyToken, baseUrl: `http://127.0.0.1:${proxyPort}/v1` } },
      channels: {}, mcp: {}, learning: { enabled: false }, tools: { restrictToWorkspace: true },
    }
    writePrivateFile(join(directory, 'runtime.config.json'), JSON.stringify(config))
    await mkdir(dirname(project.configPath), { recursive: true })
    writePrivateFile(project.configPath, JSON.stringify({
      ...(nodeOnly ? { tools: { exec: { nodeOnly: true } } } : {}),
      learning: { enabled: false }, voice: { enabled: false }, a2a: { server: {
      url: `${base}/projects/default/a2a`, agentType: 'app-acceptance', callers: { tester: 'SHADOW_TEST_CALLER' }, timeoutMs: 1_800_000,
    } } }))
    const general = await readFile(join(root, 'src', 'agent', 'types', 'builtin', 'general', 'AGENT.md'), 'utf8')
    const agent = general.replace('root: true', 'root: true\nallowedTools: [read, search, write, edit, exec, work, ask, reply, cancel, continuation, log, invoke_tool, session, sql]')
      + (testBoundaries ? `\n\n## Isolated acceptance boundaries (not product requirements)\n\n${testBoundaries}\n` : '')
    const agentDir = join(project.home, 'agents', 'app-acceptance'); await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'AGENT.md'), agent)
    const env: NodeJS.ProcessEnv = {
      ...acceptanceRuntimeEnv(directory, process.env),
      SHADOW_TEST_PORT: String(port), SHADOW_TEST_OWNER: ownerToken, SHADOW_TEST_CALLER: callerToken,
    }
    const launch = async () => {
      child = fork(fileURLToPath(import.meta.url), ['--runtime', directory], {
        cwd: directory, env, execArgv: ['--import', import.meta.resolve('tsx')], silent: true,
      })
      childClosed = once(child, 'close').then(([code, signal]) => ({ code: code ?? -1, signal, success: code === 0 }))
      // Observe again during finalization; do not lose early spawn/IPC errors while awaiting readiness.
      void childClosed.catch(() => {})
      child.stdout!.setEncoding('utf8').on('data', chunk => { logs += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { logs += chunk })
      await Promise.race([
        once(child, 'message').then(([message]) => assert.equal(message, 'ready')),
        once(child, 'exit').then(([code]) => { throw new Error(`Runtime exited before ready: ${code}`) }),
        delay(30_000, undefined, { ref: false }).then(() => { throw new Error('Runtime readiness timed out') }),
      ])
      assert.deepEqual(await owner(''), { apps: state === 'starting' ? [] : (await owner('')).apps })
      const learning = z.object({ enabled: z.literal(false) }).passthrough().parse(await ownerRequest('/learning'))
      await artifact('learning.json', learning)
    }
    await launch()
    state = 'running'
    await artifact('isolation.json', { sourceRoot: root, directory, runtimePid: child!.pid,
      controllerPid: process.pid, runtimePort: port, modelProxyPort: proxyPort,
      testBoundaries: testBoundaries ?? null, maxCalls, nodeOnly })
    console.log(JSON.stringify({ state: 'isolated-runtime-ready', runtimePid: child!.pid,
      runtimePort: port, modelProxyPort: proxyPort }))
    await artifact('prompt.json', { prompt, model, directory, maxCalls, nodeOnly, startedAt: new Date().toISOString(),
      isolation: 'Fresh Project/Home/workdir/profile/ports; no copied memories, sessions or app code; model-only proxy; standard provider login stays in parent process.' })
    timeline = new AcceptanceTimeline()
    await artifact('timeline.json', timeline.snapshot())
    task = await send(prompt)
    const commands = new Set<string>()
    const workDetails = new Map<string, { sequence: number; detail: unknown }>()
    while (true) {
      if (timeline.snapshot().phase === 'creation' && timeline.snapshot().remainingMs === 0) {
        timeline.review()
        const current = acceptanceTaskSchema.parse(await rpc('GetTask', { id: task!.id, historyLength: 10 }))
        task = await stopAcceptanceCreation(current,
          async () => acceptanceTaskSchema.parse(await rpc('CancelTask', { id: current.id })),
          async () => acceptanceTaskSchema.parse(await rpc('GetTask', { id: current.id, historyLength: 10 })))
        await artifact('creation-stop.json', { task, at: new Date().toISOString(), timeline: timeline.snapshot(),
          notice: 'Creation ended; cancellation is not completed implementation or a passed check. Review only actual publications.' })
        await artifact('timeline.json', timeline.snapshot())
        await exportAcceptanceBundles(project.home, output)
      }
      if (timeline.snapshot().remainingMs === 0) throw new Error(`Live test ${timeline.snapshot().phase} deadline reached; stopped without claiming app acceptance`)
      task = acceptanceTaskSchema.parse(await rpc('GetTask', { id: task!.id, historyLength: 10 }))
      await artifact('task.json', task)
      const apps = (await owner('')).apps as Array<{ id: string; revision: string }>
      await artifact('apps.json', await Promise.all(apps.map(app => owner(`/${app.id}`))))
      if (timeline.snapshot().phase === 'review' && apps.length === 0) {
        throw new Error('Creation ended without a published candidate; source retained as recovery evidence, not delivered acceptance')
      }
      const work = projectWorkOverviewSchema.parse(await ownerRequest('/work'))
      await artifact('work.json', work)
      for (const item of work.items) {
        if (workDetails.get(item.key)?.sequence !== item.sequence) {
          workDetails.set(item.key, { sequence: item.sequence, detail: await ownerRequest(`/work/${encodeURIComponent(item.key)}`) })
        }
      }
      await artifact('work-details.json', [...workDetails.values()].map(value => value.detail))
      await artifact('progress.json', { state, taskId: task!.id, contextId: task!.contextId, status: task!.status, calls, maxCalls,
        deadlineAt: timeline.snapshot().deadlineAt, timeline: timeline.snapshot(), apps: apps.length,
        blockedWork: work.items.filter(item => item.status === 'blocked').length,
        pendingWorkReviews: work.items.filter(item => item.contextChanged || item.notes?.attention && !item.notes.attention.reviewed).length })
      const controlPath = join(output, 'control.json')
      let control: { id: string; action: string; appId?: string; revision?: string; text?: string;
        workKey?: string } | undefined
      try { control = JSON.parse(await readFile(controlPath, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (control && !commands.has(control.id)) {
        if (control.action === 'finish') { state = 'finished'; break }
        if (timeline.snapshot().remainingMs === 0) continue
        commands.add(control.id)
        const command = control
        const result = await acceptanceOperatorAttempt(command.id, command.action, async () => {
          const control = command
          if (control.action === 'review' || control.action === 'approve') {
            if (!appId.safeParse(control.appId).success || !revisionId.safeParse(control.revision).success) {
              throw new AcceptanceControlError('Operator review requires an exact app ID and revision')
            }
            if (!acceptanceTaskTerminal(task!)) throw new AcceptanceControlError('Wait for the creation task to finish before review or approval')
            const reviewed = await owner(`/${control.appId}`)
            if (reviewed.revision !== control.revision) throw new AcceptanceControlError('Review is stale; inspect the current exact app revision')
            if (timeline!.snapshot().phase !== 'testing') timeline!.review()
            if (timeline!.snapshot().remainingMs === 0) throw new Error('Review/testing deadline expired before approval')
            await artifact('timeline.json', timeline!.snapshot())
            await artifact('review.json', { reviewed, at: new Date().toISOString(), timeline: timeline!.snapshot() })
            await exportAcceptanceBundles(project.home, output)
            if (control.action === 'approve') {
              // Hold concurrent model admissions until the exact owner operation has a known outcome.
              const gate = Promise.withResolvers<void>()
              approvalGate = gate.promise
              try {
                if (timeline!.snapshot().remainingMs === 0) throw new Error('Review/testing deadline expired before approval')
                const approved = appRecordSchema.strip().parse(await owner(`/${control.appId}/approve`, { revision: control.revision, confirm: true }))
                if (approved.id !== control.appId || approved.revision !== control.revision || approved.approval?.revision !== control.revision) {
                  throw new Error('Owner approval response does not match the reviewed version')
                }
                await artifact('approval.json', { id: approved.id, revision: approved.revision, approvedAt: approved.approval.at })
                timeline!.approved(approved.approval.at)
                await artifact('timeline.json', timeline!.snapshot())
              } finally { approvalGate = undefined; gate.resolve() }
            }
          } else if (control.action === 'snapshot') {
            await exportAcceptanceBundles(project.home, output)
          } else if (control.action === 'review-work') {
            if (!control.workKey || control.workKey.length > 600) throw new AcceptanceControlError('Operator Work review requires an exact workKey')
            const key = control.workKey
            const path = `/work/${encodeURIComponent(key)}`
            const detail = await ownerRequest(path)
            await artifact('work-review.json', detail)
          } else if (control.action === 'approve-work') {
            throw new AcceptanceControlError('Work notes no longer require approval. Correct goals in the Project canvas; app authorization still requires approve with the exact app ID and revision.')
          } else if (control.action === 'open') {
            const opened = await owner(`/${control.appId}/open`, {})
            // A launch ticket is intentionally kept out of logs/reports; only this private operator handoff contains it.
            writePrivateFile(join(output, 'launch.private.json'), JSON.stringify(opened))
          } else if (control.action === 'restart') {
            child!.send('shutdown'); await once(child!, 'exit'); await launch()
            await artifact('restart.json', { apps: (await owner('')).apps, restartedAt: new Date().toISOString() })
          } else if (control.action === 'message') {
            if (timeline!.snapshot().phase !== 'creation' || timeline!.snapshot().remainingMs === 0) {
              throw new AcceptanceControlError('Product follow-ups belong to creation; review/testing do not restart its budget')
            }
            task = await send(control.text, task)
          } else throw new AcceptanceControlError('Unknown operator control')
        })
        await artifact('control-result.json', result)
      }
      await delay(2000)
    }
  } catch (error) {
    state = 'failed'
    await artifact('controller-failure.json', { at: new Date().toISOString(), ...acceptanceProviderFailure(error),
      message: error instanceof Error ? error.message : String(error) })
    throw error
  } finally {
    try {
      if (child && childClosed) {
        if (child.exitCode === null && child.connected) child.send('shutdown')
        let timer: ReturnType<typeof setTimeout> | undefined
        let closed: ManagedProcessStatus | undefined
        try {
          closed = await Promise.race([childClosed, new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 15000) })])
        } finally { clearTimeout(timer) }
        const forced = !closed
        closed ??= await terminateProcessTree(child, childClosed, true)
        await artifact('shutdown.json', { ...closed, forced })
        if (!closed.success) throw new Error('Test runtime did not shut down cleanly; runtime directory retained for recovery')
      }
    } catch (error) {
      await artifact('recovery-failure.json', { phase: 'shutdown', retainedDirectory: directory,
        message: error instanceof Error ? error.message : String(error) })
      throw error
    } finally {
      if ('closeAllConnections' in proxy) proxy.closeAllConnections()
      await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
      await writeFile(join(output, 'runtime.log'), redact(logs))
    }
    const sessions = projectStoragePath(project.home, '.sessions')
    try {
      for (const entry of await readdir(sessions, { withFileTypes: true })) {
        if (entry.isFile() && /\.(json|jsonl)$/.test(entry.name)) {
          await mkdir(join(output, 'trace'), { recursive: true })
          await writeFile(join(output, 'trace', entry.name), redact(await readFile(join(sessions, entry.name), 'utf8')))
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await rm(join(output, 'launch.private.json'), { force: true })
    let runtimeRemoved = false
    try {
      const publications = await exportAcceptanceBundles(project.home, output)
      const recovery = await exportAcceptanceRecovery(project.home, output, publications, secrets)
      await artifact('recovery.json', recovery)
      await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
      runtimeRemoved = true
      await artifact('final.json', { state, calls, maxCalls, task, stoppedAt: new Date().toISOString(), cleanedDirectory: directory,
        sourceRecovery: 'recovery.json', timeline: timeline?.snapshot() })
    } catch (error) {
      await artifact('recovery-failure.json', { phase: 'source-export-or-cleanup', runtimeRemoved,
        ...(runtimeRemoved ? { artifactsDirectory: output } : { retainedDirectory: directory }),
        message: error instanceof Error ? error.message : String(error) })
      throw error
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: {
    runtime: { type: 'string' }, output: { type: 'string' }, prompt: { type: 'string' },
    'test-boundaries': { type: 'string' }, 'max-calls': { type: 'string' }, 'runtime-root': { type: 'string' },
    'node-only': { type: 'boolean' }, help: { type: 'boolean' },
  } })
  if (values.runtime) await runtimeChild(resolve(values.runtime))
  else if (values.output) await runAcceptance(resolve(values.output), await loadAcceptancePrompt(values.prompt),
    values['test-boundaries'] ? await loadAcceptancePrompt(values['test-boundaries']) : undefined,
    acceptanceCallBudget(values['max-calls']), values['runtime-root'], values['node-only'])
  else console.log('Live opt-in: SHADOW_MICROAPP_LIVE=1 node --import tsx scripts\\microapp-a2a.ts --output <fresh-artifact-directory> [--runtime-root <fresh-short-project-local-directory>] [--prompt <UTF-8-file>] [--test-boundaries <UTF-8-file>] [--max-calls <1-100>] [--node-only]\nUses the standard Copilot provider login. See docs/microapps.md for isolated operator review controls.')
}
