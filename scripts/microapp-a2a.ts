import assert from 'node:assert/strict'
import { fork, type ChildProcess } from 'node:child_process'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
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
import { terminateProcessTree } from '../src/execution/processes/manager.ts'
import { reserveAppPort } from '../src/microapps/ports.ts'
import { appId, appRecordSchema } from '../src/microapps/contracts.ts'
import { MicroAppStore } from '../src/microapps/store.ts'

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
  }
}

async function live(output: string, prompt: string, testBoundaries?: string) {
  if (process.env.SHADOW_MICROAPP_LIVE !== '1') throw new Error('Set SHADOW_MICROAPP_LIVE=1 to authorize a live, potentially billable model test')
  const directory = join(output, 'runtime')
  await mkdir(output)
  await mkdir(directory)
  const provider = new CopilotProvider()
  const model = process.env.SHADOW_MICROAPP_MODEL ?? DEFAULT_COPILOT_MODEL
  const models = await provider.listModels()
  if (!models.includes(model)) {
    await rm(directory, { recursive: true, force: true })
    throw new Error(`Model ${model} is unavailable through the standard Copilot login; no test session was created`)
  }
  const secrets = [randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url'), randomBytes(32).toString('base64url')]
  const [proxyToken, ownerToken, callerToken] = secrets
  const redact = (value: string) => secrets.reduce((text, secret) => text.replaceAll(secret, '[TEST_CREDENTIAL]'), value)
  const artifact = async (name: string, value: unknown) => writeAcceptanceArtifact(join(output, name), redact(JSON.stringify(value, null, 2)))
  let calls = 0
  const chat = provider.chat.bind(provider)
  provider.chat = async (...args) => {
    try { return await chat(...args) }
    catch (error) {
      await artifact('provider-failure.json', { call: calls, at: new Date().toISOString(), ...acceptanceProviderFailure(error) })
      throw error
    }
  }
  const proxyApp = new Hono()
  proxyApp.use('*', async (c, next) => {
    if (c.req.header('authorization') !== `Bearer ${proxyToken}`) return c.json({ error: 'unauthorized' }, 401)
    if (c.req.method === 'POST') {
      if (calls >= 100) return c.json({ error: 'live_test_call_budget_exhausted' }, 429)
      const body = await c.req.json()
      if (body.model !== model) return c.json({ error: 'test_model_not_allowed' }, 403)
      calls++
    }
    return next()
  })
  providerPlugin(provider)(proxyApp)
  const listening = Promise.withResolvers<number>()
  const proxy = serve({ fetch: proxyApp.fetch, hostname: '127.0.0.1', port: 0 }, info => listening.resolve(info.port))
  proxy.once('error', listening.reject)
  let child: ChildProcess | undefined, logs = '', state = 'starting'
  let base = '', task: Record<string, unknown> | undefined
  const owner = async (path: string, body?: unknown) => {
    const response = await fetch(base + '/projects/default/api/microapps' + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
    })
    const value = await response.json()
    if (!response.ok) throw new Error(`Owner operation failed: ${response.status} ${value.message ?? ''}`)
    return value
  }
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
  const home = join(directory, 'home'), project = projectPaths(`${home}.projects`, 'default')
  try {
    const proxyPort = await listening.promise, port = await reserveAppPort()
    base = `http://127.0.0.1:${port}`
    await mkdir(project.home, { recursive: true })
    await mkdir(join(directory, 'profile'), { recursive: true })
    const config = {
      agent: { workspace: home, model: `${model}@openai`, sessionStorage: 'jsonl', maxToolIterations: 80 },
      providers: { openai: { apiKey: proxyToken, baseUrl: `http://127.0.0.1:${proxyPort}/v1` } },
      channels: {}, mcp: {}, learning: { enabled: false }, tools: { restrictToWorkspace: true },
    }
    writePrivateFile(join(directory, 'runtime.config.json'), JSON.stringify(config))
    await mkdir(dirname(project.configPath), { recursive: true })
    writePrivateFile(project.configPath, JSON.stringify({ voice: { enabled: false }, a2a: { server: {
      url: `${base}/projects/default/a2a`, agentType: 'app-acceptance', callers: { tester: 'SHADOW_TEST_CALLER' }, timeoutMs: 1_800_000,
    } } }))
    const general = await readFile(join(root, 'src', 'agent', 'types', 'builtin', 'general', 'AGENT.md'), 'utf8')
    const agent = general.replace('root: true', 'root: true\nallowedTools: [read, search, write, edit, exec, work, ask, reply, cancel, continuation, log, invoke_tool, session, sql]')
      + (testBoundaries ? `\n\n## Isolated acceptance boundaries (not product requirements)\n\n${testBoundaries}\n` : '')
    const agentDir = join(project.home, 'agents', 'app-acceptance'); await mkdir(agentDir, { recursive: true })
    await writeFile(join(agentDir, 'AGENT.md'), agent)
    const env: NodeJS.ProcessEnv = {
      SHADOW_TEST_PORT: String(port), SHADOW_TEST_OWNER: ownerToken, SHADOW_TEST_CALLER: callerToken,
      GITHUB_COPILOT_TOKEN_DIR: join(directory, 'empty-auth'),
    }
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|LANG|LC_ALL)$/i.test(key)) env[key] = value
    }
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = join(directory, 'profile')
    const launch = async () => {
      child = fork(fileURLToPath(import.meta.url), ['--runtime', directory], {
        cwd: directory, env, execArgv: ['--import', import.meta.resolve('tsx')], silent: true,
      })
      child.stdout!.setEncoding('utf8').on('data', chunk => { logs += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { logs += chunk })
      await Promise.race([
        once(child, 'message').then(([message]) => assert.equal(message, 'ready')),
        once(child, 'exit').then(([code]) => { throw new Error(`Runtime exited before ready: ${code}`) }),
        delay(30_000, undefined, { ref: false }).then(() => { throw new Error('Runtime readiness timed out') }),
      ])
      assert.deepEqual(await owner(''), { apps: state === 'starting' ? [] : (await owner('')).apps })
    }
    await launch()
    state = 'running'
    await artifact('isolation.json', { sourceRoot: root, directory, runtimePid: child!.pid,
      controllerPid: process.pid, runtimePort: port, modelProxyPort: proxyPort,
      testBoundaries: testBoundaries ?? null })
    console.log(JSON.stringify({ state: 'isolated-runtime-ready', runtimePid: child!.pid,
      runtimePort: port, modelProxyPort: proxyPort }))
    await artifact('prompt.json', { prompt, model, directory, startedAt: new Date().toISOString(),
      isolation: 'Fresh Project/Home/workdir/profile/ports; no copied memories, sessions or app code; model-only proxy; standard provider login stays in parent process.' })
    task = await send(prompt)
    const deadline = Date.now() + 30 * 60_000
    const commands = new Set<string>()
    while (Date.now() < deadline) {
      task = await rpc('GetTask', { id: task!.id, historyLength: 10 })
      await artifact('task.json', task)
      const apps = (await owner('')).apps as Array<{ id: string; revision: string }>
      await artifact('apps.json', await Promise.all(apps.map(app => owner(`/${app.id}`))))
      await artifact('progress.json', { state, taskId: task!.id, contextId: task!.contextId, status: task!.status, calls, apps: apps.length })
      const controlPath = join(output, 'control.json')
      let control: { id: string; action: string; appId?: string; revision?: string; text?: string } | undefined
      try { control = JSON.parse(await readFile(controlPath, 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      if (control && !commands.has(control.id)) {
        commands.add(control.id)
        if (control.action === 'finish') { state = 'finished'; break }
        if (control.action === 'approve') {
          if (!control.appId || !control.revision) throw new Error('Operator review requires an exact app revision')
          await owner(`/${control.appId}/approve`, { revision: control.revision, confirm: true })
          await artifact('approval.json', { id: control.appId, revision: control.revision, approvedAt: new Date().toISOString() })
        } else if (control.action === 'open') {
          const opened = await owner(`/${control.appId}/open`, {})
          // A launch ticket is intentionally kept out of logs/reports; only this private operator handoff contains it.
          writePrivateFile(join(output, 'launch.private.json'), JSON.stringify(opened))
        } else if (control.action === 'restart') {
          child!.send('shutdown'); await once(child!, 'exit'); await launch()
          await artifact('restart.json', { apps: (await owner('')).apps, restartedAt: new Date().toISOString() })
        } else if (control.action === 'message') {
          task = await send(control.text, task)
        } else throw new Error('Unknown operator control')
        await artifact('control-result.json', { id: control.id, action: control.action, done: true })
      }
      await delay(2000)
    }
    if (state !== 'finished') throw new Error('Live test deadline reached; stopped without claiming app acceptance')
  } finally {
    if (child?.exitCode === null) {
      child.send('shutdown')
      const closed = once(child, 'close').then(([code, signal]) => ({ code: code ?? -1, signal, success: code === 0 }))
      const timeout = setTimeout(() => { void terminateProcessTree(child!, closed, true) }, 15_000)
      try { await closed } finally { clearTimeout(timeout) }
    }
    if ('closeAllConnections' in proxy) proxy.closeAllConnections()
    await new Promise<void>((resolve, reject) => proxy.close(error => error ? reject(error) : resolve()))
    await artifact('final.json', { state, calls, task, stoppedAt: new Date().toISOString(), cleanedDirectory: directory })
    await writeFile(join(output, 'runtime.log'), redact(logs))
    const sessions = join(project.home, '.sessions')
    try {
      for (const entry of await readdir(sessions, { withFileTypes: true })) {
        if (entry.isFile() && /\.(json|jsonl)$/.test(entry.name)) {
          await mkdir(join(output, 'trace'), { recursive: true })
          await writeFile(join(output, 'trace', entry.name), redact(await readFile(join(sessions, entry.name), 'utf8')))
        }
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    try { await exportAcceptanceBundles(project.home, output) }
    finally {
      await rm(join(output, 'launch.private.json'), { force: true })
      await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    }
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const { values } = parseArgs({ options: {
    runtime: { type: 'string' }, output: { type: 'string' }, prompt: { type: 'string' },
    'test-boundaries': { type: 'string' }, help: { type: 'boolean' },
  } })
  if (values.runtime) await runtimeChild(resolve(values.runtime))
  else if (values.output) await live(resolve(values.output), await loadAcceptancePrompt(values.prompt),
    values['test-boundaries'] ? await loadAcceptancePrompt(values['test-boundaries']) : undefined)
  else console.log('Live opt-in: SHADOW_MICROAPP_LIVE=1 node --import tsx scripts\\microapp-a2a.ts --output <fresh-artifact-directory> [--prompt <UTF-8-file>] [--test-boundaries <UTF-8-file>]\nUses the standard Copilot provider login. See docs/microapps.md for isolated operator review controls.')
}
