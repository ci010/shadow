import { execFile } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { ghTransport, type GitHubTransport } from '../src/projects/github/client.ts'
import type { ExecutionContext } from '../src/tools/context.ts'
import type { Tool, ToolParameters } from '../src/tools/tool.ts'
import type { EventWaitFixture, ExternalEventWait } from './event-wait-acceptance.ts'
import { TEST_ENVIRONMENT, uuidPattern, verifyBuildReceipt } from './event-wait-github-step.mjs'

const id = z.number().int().positive()
const runSchema = z.object({
  id, head_sha: z.string(), head_branch: z.string(), status: z.string(),
  conclusion: z.string().nullable(), display_title: z.string(), html_url: z.string().url(),
  created_at: z.string().datetime(), updated_at: z.string().datetime(),
})
const signalSchema = z.object({
  version: z.literal(1), requestId: z.string().regex(uuidPattern),
  ciRunId: id, cdRunId: id, deploymentId: id, url: z.string().url(),
  printedAt: z.string().datetime(), deadlineAt: z.string().datetime(),
})
const resultSchema = signalSchema.extend({
  passed: z.boolean(), elapsedMs: z.number().nonnegative(),
  observedAckAt: z.string().datetime().optional(), ackStatusId: id.optional(), error: z.string().optional(),
})
const checkSchema = z.object({
  id, external_id: z.string().nullable(), details_url: z.string().nullable(),
  status: z.string(), conclusion: z.string().nullable(),
  output: z.object({ text: z.string().nullable() }),
})

export interface GitHubWaitOptions {
  repository: string
  branch: string
  sha: string
  requestId: string
  ciRunId: number
  transport?: GitHubTransport
  download?: (directory: string, signal: AbortSignal) => Promise<void>
  pollMs?: number
}

export class GitHubWait implements Tool {
  readonly name = 'github_actions'
  readonly description = 'Acceptance-only, host-authenticated GitHub capability. Reads/watches the exact CI/CD pair, dispatches CD once after CI success, reads the mid-step Check Run signal, and processes its URL once by downloading/verifying the real CI artifact before acknowledging a non-production test deployment. Credentials never leave the host.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['view', 'watch', 'dispatch', 'signal', 'watch_signal', 'process'] },
      run_id: { type: 'number', description: 'Exact CI run ID or the CD ID returned by dispatch. Required for view/watch.' },
      url: { type: 'string', description: 'Exact URL from the running third-step signal. Required for process.' },
    },
    required: ['action'], additionalProperties: false,
  }
  readonly readonly = (args: Record<string, unknown>) => !['dispatch', 'process'].includes(String(args.action))
  readonly controller = new AbortController()
  readonly requests: Array<{ at: string; method: string; path: string; actor: 'agent' | 'observer' }> = []
  readonly dispatches: EventWaitFixture['dispatches'] = []
  readonly attempts: EventWaitFixture['attempts'] = []
  private cdRunId?: number
  private dispatchClaimed = false
  private processClaimed = false
  private workdir?: string
  private lastRefresh = 0
  private observationValue: ReturnType<EventWaitFixture['observation']> = {
    firstCompletedAt: undefined, secondStartedAt: undefined, secondCompletedAt: undefined,
    urlPrintedAt: undefined, urlDeadlineAt: undefined, urlProcessedAt: undefined,
    thirdStepStatus: 'pending', urlLatencyMs: null,
  }
  private gateResult?: z.infer<typeof resultSchema>

  constructor(readonly options: GitHubWaitOptions) {
    z.object({
      repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/), branch: z.literal('session'),
      sha: z.string().regex(/^[a-f0-9]{40}$/), requestId: z.string().regex(uuidPattern), ciRunId: id,
      pollMs: z.number().int().min(1).max(30_000).optional(),
    }).parse(options)
  }

  get base() { return `repos/${this.options.repository}` }
  get evidence() {
    return {
      ...this.options, transport: undefined, download: undefined, requests: this.requests,
      dispatches: this.dispatches, attempts: this.attempts, cdRunId: this.cdRunId,
      gateResult: this.gateResult, observation: this.observationValue,
    }
  }
  private async request(path: string, method: 'GET' | 'POST' | 'PATCH', body: unknown, signal: AbortSignal, actor: 'agent' | 'observer' = 'agent') {
    const combined = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(30_000)])
    combined.throwIfAborted()
    this.requests.push({ at: new Date().toISOString(), method, path, actor })
    return (this.options.transport ?? ghTransport)(path, method, body, combined)
  }
  private async run(runId: number, signal: AbortSignal, actor: 'agent' | 'observer' = 'agent') {
    if (runId !== this.options.ciRunId && runId !== this.cdRunId) throw new Error('Run is outside this acceptance pair')
    const run = runSchema.parse(await this.request(`${this.base}/actions/runs/${runId}`, 'GET', undefined, signal, actor))
    const phase = runId === this.options.ciRunId ? 'ci' : 'cd'
    if (run.id !== runId || run.head_sha !== this.options.sha || run.head_branch !== this.options.branch ||
      run.display_title !== `Shadow event wait ${phase} ${this.options.requestId}`) throw new Error('Run identity mismatch')
    if (phase === 'ci' && run.status === 'completed') this.observationValue.firstCompletedAt ??= run.updated_at
    if (phase === 'cd') {
      this.observationValue.secondStartedAt ??= run.created_at
      if (run.status === 'completed') this.observationValue.secondCompletedAt ??= run.updated_at
    }
    return run
  }
  private async signal(signal: AbortSignal, actor: 'agent' | 'observer' = 'agent') {
    if (!this.cdRunId) throw new Error('CD has not been dispatched')
    const name = `shadow-event-wait-url-${this.options.requestId}`
    const response = z.object({ total_count: z.number().int().min(0).max(1), check_runs: z.array(checkSchema).max(1) }).parse(
      await this.request(`${this.base}/commits/${this.options.sha}/check-runs?check_name=${name}&per_page=100`, 'GET', undefined, signal, actor))
    const check = response.check_runs[0]
    if (!check) return { status: 'pending', signal: null, result: null }
    const allowedDetails = [
      `https://github.com/${this.options.repository}/actions/runs/${this.cdRunId}`,
      `https://github.com/${this.options.repository}/runs/${check.id}`,
    ]
    if (check.external_id !== this.options.requestId ||
      !allowedDetails.includes(check.details_url ?? '') || !check.output.text) {
      throw new Error('URL Check Run identity mismatch')
    }
    const content: unknown = JSON.parse(check.output.text)
    const value = signalSchema.parse(content)
    if (value.requestId !== this.options.requestId || value.ciRunId !== this.options.ciRunId ||
      value.cdRunId !== this.cdRunId || value.url !== `https://api.github.com/${this.base}/deployments/${value.deploymentId}/statuses` ||
      Date.parse(value.deadlineAt) - Date.parse(value.printedAt) !== 60_000) throw new Error('Invalid correlated URL/deadline')
    this.observationValue.urlPrintedAt = value.printedAt
    this.observationValue.urlDeadlineAt = value.deadlineAt
    this.observationValue.thirdStepStatus = 'in_progress'
    let result: z.infer<typeof resultSchema> | null = null
    if (check.status === 'completed') {
      result = resultSchema.parse(content)
      if ((check.conclusion === 'success') !== result.passed ||
        result.passed && (!result.observedAckAt || !result.ackStatusId || result.elapsedMs >= 60_000)) throw new Error('Inconsistent runner deadline result')
      this.gateResult = result
      this.observationValue.thirdStepStatus = result.passed ? 'completed' : 'timed_out'
      this.observationValue.urlProcessedAt = result.observedAckAt
      this.observationValue.urlLatencyMs = result.passed ? result.elapsedMs : null
    }
    return { status: check.status, signal: value, result }
  }
  private async dispatch(signal: AbortSignal) {
    if (this.dispatchClaimed) {
      this.dispatches.push({ at: new Date().toISOString(), accepted: false })
      throw new Error('Dispatch already attempted; do not retry an uncertain write')
    }
    const ci = await this.run(this.options.ciRunId, signal)
    if (ci.status !== 'completed' || ci.conclusion !== 'success') {
      this.dispatches.push({ at: new Date().toISOString(), accepted: false })
      throw new Error('CI must have completed successfully before dispatch')
    }
    this.dispatchClaimed = true
    await this.request(`${this.base}/actions/workflows/event-wait-live.yml/dispatches`, 'POST', {
      ref: this.options.branch, inputs: { phase: 'cd', request_id: this.options.requestId,
        ci_run_id: String(this.options.ciRunId), url_timeout_seconds: '60' },
    }, signal)
    this.dispatches.push({ at: new Date().toISOString(), accepted: true })
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const runs = z.object({ workflow_runs: z.array(runSchema) }).parse(await this.request(
        `${this.base}/actions/workflows/event-wait-live.yml/runs?event=workflow_dispatch&branch=${this.options.branch}&per_page=30`,
        'GET', undefined, signal))
      const matches = runs.workflow_runs.filter(run => run.display_title === `Shadow event wait cd ${this.options.requestId}`)
      if (matches.length > 1) throw new Error('Duplicate correlated CD runs')
      if (matches[0]) {
        this.cdRunId = matches[0].id
        return this.run(this.cdRunId, signal)
      }
      await delay(this.options.pollMs ?? 3000, undefined, { signal })
    }
    throw new Error('Dispatch accepted but run discovery timed out; do not dispatch again')
  }
  private async download(directory: string, signal: AbortSignal) {
    if (this.options.download) return this.options.download(directory, signal)
    await new Promise<void>((resolve, reject) => {
      execFile('gh', ['run', 'download', String(this.options.ciRunId), '--repo', this.options.repository,
        '--name', `shadow-event-wait-${this.options.requestId}`, '--dir', directory],
      { signal, timeout: 30_000, windowsHide: true, maxBuffer: 1024 * 1024,
        env: { ...process.env, GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat' } }, error => {
        if (error) reject(signal.aborted ? signal.reason : new Error('GitHub CI artifact download failed; no acknowledgement was sent'))
        else resolve()
      })
    })
  }
  private async process(url: string, signal: AbortSignal) {
    if (this.processClaimed) throw new Error('URL processing already attempted; do not retry an uncertain write')
    const current = await this.signal(signal)
    if (!current.signal || current.status !== 'in_progress' || current.signal.url !== url ||
      Date.now() >= Date.parse(current.signal.deadlineAt)) throw new Error('URL is not the exact currently-running third-step URL')
    const cd = await this.run(current.signal.cdRunId, signal)
    if (cd.status !== 'in_progress') throw new Error('CD is not running')
    const deployment = z.object({
      id, sha: z.string(), environment: z.literal(TEST_ENVIRONMENT), production_environment: z.literal(false),
      transient_environment: z.literal(true), payload: z.object({ requestId: z.string(), ciRunId: id, cdRunId: id }),
    }).parse(await this.request(`${this.base}/deployments/${current.signal.deploymentId}`, 'GET', undefined, signal))
    if (deployment.id !== current.signal.deploymentId || deployment.sha !== this.options.sha ||
      deployment.payload.requestId !== this.options.requestId || deployment.payload.ciRunId !== this.options.ciRunId ||
      deployment.payload.cdRunId !== this.cdRunId || !this.workdir) throw new Error('Deployment/workdir identity mismatch')
    this.processClaimed = true
    const bounded = AbortSignal.any([signal, this.controller.signal, AbortSignal.timeout(
      Math.max(1, Date.parse(current.signal.deadlineAt) - Date.now()))])
    const directory = join(this.workdir, 'real-ci-artifact')
    await mkdir(directory)
    await this.download(directory, bounded)
    const verified = await verifyBuildReceipt(directory, {
      requestId: this.options.requestId, repository: this.options.repository, sha: this.options.sha, runId: this.options.ciRunId,
    })
    bounded.throwIfAborted()
    if (Date.now() >= Date.parse(current.signal.deadlineAt)) throw new Error('Artifact processing exceeded the URL deadline; no acknowledgement sent')
    const acknowledgement = z.object({ id, state: z.literal('success'), created_at: z.string().datetime() }).parse(
      await this.request(`${this.base}/deployments/${deployment.id}/statuses`, 'POST', {
        state: 'success', description: `event-wait:${this.options.requestId}:url-processed`,
        environment: TEST_ENVIRONMENT, auto_inactive: false,
      }, bounded))
    this.attempts.push({ at: acknowledgement.created_at, accepted: true })
    return { acknowledgement, verified, url }
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext) {
    const action = z.enum(['view', 'watch', 'dispatch', 'signal', 'watch_signal', 'process']).parse(args.action)
    const signal = AbortSignal.any([context.signal, this.controller.signal])
    if (action === 'view') return JSON.stringify(await this.run(id.parse(args.run_id), signal))
    if (action === 'dispatch') return JSON.stringify(await this.dispatch(signal))
    if (action === 'process') return JSON.stringify(await this.process(z.string().url().parse(args.url), signal))
    if (action === 'signal') return JSON.stringify(await this.signal(signal))
    while (true) {
      signal.throwIfAborted()
      if (action === 'watch') {
        const run = await this.run(id.parse(args.run_id), signal)
        if (run.status === 'completed') return JSON.stringify(run)
      } else {
        const current = await this.signal(signal)
        if (current.signal) return JSON.stringify(current)
        const cd = await this.run(id.parse(this.cdRunId), signal)
        if (cd.status === 'completed') throw new Error('CD completed without a third-step URL signal')
      }
      await delay(this.options.pollMs ?? 3000, undefined, { signal })
    }
  }
  async refresh(signal: AbortSignal) {
    if (Date.now() - this.lastRefresh < 5000 &&
      (!this.observationValue.secondCompletedAt || this.gateResult)) return
    this.lastRefresh = Date.now()
    const ci = await this.run(this.options.ciRunId, signal, 'observer')
    if (ci.status === 'completed' && ci.conclusion !== 'success') throw new Error(`Real CI failed: ${ci.conclusion}`)
    if (this.cdRunId) {
      const cd = await this.run(this.cdRunId, signal, 'observer')
      const current = await this.signal(signal, 'observer')
      if (cd.status === 'completed' && cd.conclusion !== 'success' && !current.result) {
        throw new Error(`Real CD failed before the deadline receipt: ${cd.conclusion}`)
      }
    }
  }
  asScenario(): ExternalEventWait {
    return {
      fixture: {
        origin: 'https://api.github.com', requests: this.requests, dispatches: this.dispatches, attempts: this.attempts, signals: [],
        observation: () => ({ ...this.observationValue }),
        close: async () => { this.controller.abort(new Error('Acceptance closed')) },
      },
      prompt: `请实际完成这个真实 GitHub Actions 工作流。仓库 ${this.options.repository}，验收 commit ${this.options.sha}，request ${this.options.requestId}。
先等 CI run ${this.options.ciRunId} 成功结束，再且只启动一次 CD run；CI 失败则停止。CD 使用真实 CI 构建产物，有三步；第三步 print PROCESS_URL，并在 GitHub Check Run 中同步公开 URL、printedAt、deadlineAt。必须在 print 之后 60 秒内处理 URL，只处理一次，不能等 CD 全部结束后才找 URL。最后核实 CI、CD 和 runner 期限结果，如实报告。
宿主已登录 GitHub，但凭据不会交给模型或脚本。可发现的 github_actions 是测试专用宿主鉴权 capability，只允许本次 CI/CD：
invoke_tool({name:"github_actions",args:{action:"view",run_id:<id>}}) 查 run；
watch 等 run 完成并返回实际 conclusion；dispatch 在 CI 成功后启动 CD，返回它的真实 run ID；
signal 查询第三步 Check Run；watch_signal 等待其出现，返回 {status,signal:{url,printedAt,deadlineAt,...},result}；
process + url 参数验证真实 CI artifact 的文件 SHA256，然后确认一个 transient、非生产 test deployment；
只能用该 capability 操作本次验收；不得自行调用 gh、读取用户配置/凭据/旧会话、安装依赖或操作正式发布。
执行方式自行选择。普通 OS shell 的 node 不注入 Shadow 工具 SDK；如需脚本调用宿主 capability，exec 的 shell:"node" 提供 invoke_tool，返回已解析的数据。v:skills/node-scripting 是实际使用指南。现有 event、cron、background、continuation 工具也可自行发现。
第三步信号是实际 GitHub API，不是本地模拟，也不是 GitHub REST 运行中日志流。`,
      configure: async (importer, workdir) => { this.workdir = workdir; importer.registerBuiltin('github_actions', this) },
      refresh: signal => this.refresh(signal),
      request: async (url, init) => {
        const parsed = new URL(String(url))
        const prefix = `/${this.base}/`
        const ci = `${prefix}actions/runs/${this.options.ciRunId}`
        const cd = this.cdRunId ? `${prefix}actions/runs/${this.cdRunId}` : undefined
        const checks = `${prefix}commits/${this.options.sha}/check-runs`
        if (parsed.origin !== 'https://api.github.com' || (init?.method ?? 'GET') !== 'GET' ||
          ![ci, cd, checks].includes(parsed.pathname) ||
          parsed.pathname === checks && parsed.searchParams.get('check_name') !== `shadow-event-wait-url-${this.options.requestId}`) {
          throw new Error('HTTP source is outside the explicitly approved acceptance read routes')
        }
        const value = await this.request(parsed.pathname.slice(1) + parsed.search, 'GET', undefined,
          AbortSignal.any([init?.signal ?? this.controller.signal, this.controller.signal]))
        return Response.json(value)
      },
    }
  }
}
