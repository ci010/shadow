import { createServer, type ServerResponse } from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'

export const ACTIONS_RUN_ID = 424242
export const SECOND_RUN_ID = 424243
export const ACTIONS_RUN_PATH = `/repos/fixture/actions/actions/runs/${ACTIONS_RUN_ID}`
export const SECOND_RUN_PATH = `/repos/fixture/actions/actions/runs/${SECOND_RUN_ID}`
export const DISPATCH_PATH = '/repos/fixture/actions/actions/workflows/second.yml/dispatches'
export const LIVE_LOG_PATH = `/live-logs/${SECOND_RUN_ID}`
export type ActionsConclusion = 'success' | 'failure'
export interface FixtureSignal {
  id: string
  type: string
  content: string
}

export async function createActionsFixture(options: { urlTimeoutMs?: number; stepDelayMs?: number } = {}) {
  const urlTimeoutMs = options.urlTimeoutMs ?? 60_000
  const stepDelayMs = options.stepDelayMs ?? 3000
  let firstConclusion: ActionsConclusion | null = null
  let firstCompletedAt: string | undefined
  let secondStartedAt: string | undefined
  let secondCompletedAt: string | undefined
  let secondConclusion: ActionsConclusion | null = null
  let urlPrintedAt: string | undefined
  let urlDeadlineAt: string | undefined
  let urlProcessedAt: string | undefined
  let thirdStepStatus: 'pending' | 'in_progress' | 'completed' | 'timed_out' = 'pending'
  let currentStep = 0
  let origin = ''
  const processPath = `/process/${randomUUID()}`
  const requests: Array<{ at: string; method: string; path: string }> = []
  const dispatches: Array<{ at: string; accepted: boolean }> = []
  const attempts: Array<{ at: string; accepted: boolean; reason?: string }> = []
  const signals: FixtureSignal[] = []
  const logs: string[] = []
  const streams = new Set<ServerResponse>()
  const waiters = new Map<number, Set<() => void>>()
  const timers = new Set<ReturnType<typeof setTimeout>>()
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); fn() }, ms)
    timers.add(timer)
  }
  const firstRun = () => ({
    id: ACTIONS_RUN_ID, run_attempt: 1, status: firstConclusion === null ? 'in_progress' : 'completed',
    conclusion: firstConclusion, completed_at: firstCompletedAt ?? null,
  })
  const secondRun = () => ({
    id: SECOND_RUN_ID, run_attempt: 1,
    status: !secondStartedAt ? 'not_started' : secondConclusion === null ? 'in_progress' : 'completed',
    conclusion: secondConclusion, current_step: currentStep,
    steps: [
      { number: 1, name: 'Prepare', status: currentStep > 1 ? 'completed' : currentStep === 1 ? 'in_progress' : 'pending' },
      { number: 2, name: 'Build', status: currentStep > 2 ? 'completed' : currentStep === 2 ? 'in_progress' : 'pending' },
      { number: 3, name: 'Process printed URL', status: thirdStepStatus },
    ],
    completed_at: secondCompletedAt ?? null,
  })
  const appendLog = (line: string) => {
    logs.push(line)
    for (const response of streams) response.write(line + '\n')
  }
  const finishSecond = (conclusion: ActionsConclusion) => {
    secondConclusion = conclusion
    secondCompletedAt = new Date().toISOString()
    appendLog(`Run ${SECOND_RUN_ID} completed: ${conclusion}`)
    signals.push({ id: `actions:${SECOND_RUN_ID}:1`, type: 'github.actions.completed', content: JSON.stringify(secondRun()) })
    for (const finish of waiters.get(SECOND_RUN_ID) ?? []) finish()
    for (const response of streams) response.end()
    streams.clear()
  }
  const startSecond = () => {
    secondStartedAt = new Date().toISOString()
    currentStep = 1
    appendLog('Step 1: Prepare')
    later(() => {
      currentStep = 2
      appendLog('Step 2: Build')
      later(() => {
        currentStep = 3
        thirdStepStatus = 'in_progress'
        appendLog('Step 3: running; waiting for the URL operation')
        later(() => {
          urlPrintedAt = new Date().toISOString()
          urlDeadlineAt = new Date(Date.parse(urlPrintedAt) + urlTimeoutMs).toISOString()
          const line = `PROCESS_URL=${origin}${processPath}`
          appendLog(line)
          signals.push({ id: `actions:${SECOND_RUN_ID}:url`, type: 'github.actions.log', content: line })
          later(() => {
            if (urlProcessedAt) return
            thirdStepStatus = 'timed_out'
            appendLog(`Step 3 failed: URL was not processed within ${urlTimeoutMs / 1000} seconds`)
            finishSecond('failure')
          }, urlTimeoutMs)
        }, stepDelayMs)
      }, stepDelayMs)
    }, stepDelayMs)
  }
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture').pathname
    requests.push({ at: new Date().toISOString(), method: request.method ?? '', path })
    const send = (status: number, body: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    const id = path.startsWith(SECOND_RUN_PATH) ? SECOND_RUN_ID : ACTIONS_RUN_ID
    const run = () => id === SECOND_RUN_ID ? secondRun() : firstRun()
    if (request.method === 'GET' && (path === ACTIONS_RUN_PATH || path === SECOND_RUN_PATH)) return send(200, run())
    if (request.method === 'GET' && (path === `${ACTIONS_RUN_PATH}/watch` || path === `${SECOND_RUN_PATH}/watch`)) {
      if (run().status === 'completed') return send(200, run())
      const pending = waiters.get(id) ?? new Set<() => void>()
      waiters.set(id, pending)
      const finish = () => { pending.delete(finish); send(200, run()) }
      pending.add(finish)
      response.once('close', () => pending.delete(finish))
      return
    }
    if (request.method === 'GET' && path === LIVE_LOG_PATH) return send(200, { runId: SECOND_RUN_ID, logs: [...logs] })
    if (request.method === 'GET' && path === `${LIVE_LOG_PATH}/stream`) {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
      for (const line of logs) response.write(line + '\n')
      if (secondConclusion !== null) return response.end()
      streams.add(response)
      response.once('close', () => streams.delete(response))
      return
    }
    if (request.method === 'POST' && path === DISPATCH_PATH) {
      const accepted = firstConclusion === 'success' && !secondStartedAt
      dispatches.push({ at: new Date().toISOString(), accepted })
      if (!accepted) return send(409, { error: 'Run 1 must succeed; run 2 can only be launched once' })
      startSecond()
      return send(201, secondRun())
    }
    if (request.method === 'POST' && path.startsWith('/process/')) {
      const now = new Date().toISOString()
      const reason = path !== processPath ? 'wrong-url'
        : !urlPrintedAt ? 'url-not-printed'
        : urlProcessedAt ? 'duplicate-processing'
        : !urlDeadlineAt || Date.parse(now) >= Date.parse(urlDeadlineAt) ? 'url-timeout'
        : thirdStepStatus !== 'in_progress' ? 'third-step-not-running'
        : undefined
      attempts.push({ at: now, accepted: !reason, ...(reason ? { reason } : {}) })
      if (reason) return send(409, { error: reason })
      urlProcessedAt = now
      thirdStepStatus = 'completed'
      appendLog('Step 3: URL processed')
      finishSecond('success')
      return send(200, { accepted: true, processedAt: now, run: secondRun() })
    }
    send(404, { error: 'Unknown fixture route' })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Fixture did not bind a TCP port')
  origin = `http://127.0.0.1:${address.port}`
  return {
    origin, requests, dispatches, attempts, signals, firstRun, secondRun,
    observation: () => ({
      firstCompletedAt, secondStartedAt, secondCompletedAt, urlPrintedAt, urlDeadlineAt, urlProcessedAt,
      thirdStepStatus, urlLatencyMs: urlPrintedAt && urlProcessedAt ? Date.parse(urlProcessedAt) - Date.parse(urlPrintedAt) : null,
    }),
    complete(value: ActionsConclusion) {
      if (firstConclusion !== null) throw new Error('Fixture run already completed')
      firstConclusion = value
      firstCompletedAt = new Date().toISOString()
      signals.push({ id: `actions:${ACTIONS_RUN_ID}:1`, type: 'github.actions.completed', content: JSON.stringify(firstRun()) })
      for (const finish of waiters.get(ACTIONS_RUN_ID) ?? []) finish()
    },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    },
  }
}

export function actionsFixtureCli(origin: string): string {
  return `
const origin = ${JSON.stringify(origin)}
const paths = {${ACTIONS_RUN_ID}:${JSON.stringify(ACTIONS_RUN_PATH)},${SECOND_RUN_ID}:${JSON.stringify(SECOND_RUN_PATH)}}
const [command, target] = process.argv.slice(2)
const runPath = paths[target]
let path, options
if (command === 'launch' && target === 'second') {
  path = ${JSON.stringify(DISPATCH_PATH)}; options = {method:'POST'}
} else if (command === 'process' && target?.startsWith(origin + '/process/')) {
  path = target.slice(origin.length); options = {method:'POST'}
} else if (['view','watch'].includes(command) && runPath) {
  path = runPath + (command === 'watch' ? '/watch' : '')
} else if (['logs','logs-watch'].includes(command) && target === '${SECOND_RUN_ID}') {
  path = ${JSON.stringify(LIVE_LOG_PATH)} + (command === 'logs-watch' ? '/stream' : '')
} else {
  throw new Error('Usage: view|watch <runId>; launch second; logs|logs-watch ${SECOND_RUN_ID}; process <printed URL>')
}
const response = await fetch(origin + path, options)
if (command === 'logs-watch' && response.ok) {
  for await (const chunk of response.body) process.stdout.write(chunk)
} else console.log(JSON.stringify(await response.json()))
if (!response.ok) process.exitCode = 1
`
}

export function eventWaitPrompt(origin: string, urlTimeoutMs = 60_000): string {
  return `请完成这个工作流：先等 GitHub Actions 的 fixture/actions run ${ACTIONS_RUN_ID} 成功结束，然后启动 second.yml 的第二个 action run（ID ${SECOND_RUN_ID}）。
第二个 run 的第三步在运行过程中会在日志中 print 一个 PROCESS_URL。拿到这个 URL 后执行 node actions-fixture.mjs process <这个URL> 来处理它，且只处理一次。
第三步从 URL print 出来开始只有 ${urlTimeoutMs / 1000} 秒，超时没处理就算失败；不能等第二个 run 全部完成以后才读日志。完成后告诉我实际结果。
如果第一个 run 失败，不启动第二个 run，如实报告。

这是可控的 Actions 模拟，不是真实仓库。工作目录里已有 actions-fixture.mjs，提供：
node actions-fixture.mjs view <runId>：当前 run JSON；
node actions-fixture.mjs watch <runId>：等到 completed 后返回 JSON，必须检查 conclusion；
node actions-fixture.mjs launch second：启动第二个 run，只允许一次；
node actions-fixture.mjs logs ${SECOND_RUN_ID}：当前日志 JSON（包括运行中日志）；
node actions-fixture.mjs logs-watch ${SECOND_RUN_ID}：实时流式日志，到 run 结束才退出；
node actions-fixture.mjs process <打印出来的URL>：执行所需处理。
原生脚本也可以访问同一模拟的 ${origin}：
GET ${ACTIONS_RUN_PATH}、GET ${SECOND_RUN_PATH} 查 run，GET <run路径>/watch 等待完成；
POST ${DISPATCH_PATH} 启动第二个 run；GET ${LIVE_LOG_PATH} 返回 {runId,logs:string[]}；
GET ${LIVE_LOG_PATH}/stream 是实时日志；POST 打印出来的 URL 完成处理。
Project HTTP broker 中 https://api.github.com 的上述两个只读 run GET 路由、
https://actions-fixture.example${LIVE_LOG_PATH} 的只读 GET 路由也映射到同一模拟，不需要 credential。
这是测试专用实时日志通道，不代表 GitHub REST API 支持读取运行中的完整日志。
broker 映射只对 Project HTTP broker 生效，原生网络请求请用本地 URL，禁止访问真实 GitHub。
只操作当前测试工作目录及上述模拟 API，不读其他目录、用户配置、凭据或旧会话，不安装依赖。`
}
