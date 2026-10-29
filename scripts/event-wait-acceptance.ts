import { projectStoragePath } from '../src/utils/data-paths.ts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { Bus } from '../src/bus/bus.ts'
import { ContextBuilder } from '../src/agent/context/builder.ts'
import { executionContractProvider, guidelineProvider } from '../src/agent/context/guideline.ts'
import { runtimeDiscoveryProvider, runtimeIdentityProvider } from '../src/agent/context/runtime.ts'
import { workspaceProvider } from '../src/agent/context/workspace.ts'
import { AgentTypesManager } from '../src/agent/types/manager.ts'
import { IdentityManager } from '../src/agent/identity.ts'
import { ChannelManager } from '../src/channels/manager.ts'
import { ConfigSchema } from '../src/config/schema.ts'
import { BackgroundTaskManager } from '../src/agent/background-task.ts'
import { CapabilityBroker } from '../src/agent-authoring/capabilities.ts'
import { DEFAULT_COPILOT_MODEL } from '../src/config/defaults.ts'
import { EventService } from '../src/events/service.ts'
import { PollingSources } from '../src/events/polling-sources.ts'
import { ProcessManager } from '../src/execution/processes/manager.ts'
import { defaultManagedShell } from '../src/execution/processes/shells.ts'
import { CopilotProviderV2 } from '../src/providers/copilot-v2.ts'
import { createProjectScope } from '../src/projects/scope.ts'
import { resolveContextWindow } from '../src/providers/model-registry.ts'
import { EvalBridgeRuntime } from '../src/script-runtime/bridge.ts'
import type { ChatMessage, LLMProvider } from '../src/providers/provider.ts'
import { SkillsManager } from '../src/skills/loader.ts'
import { SessionManager } from '../src/sessions/session-manager.ts'
import { JsonlSessionStore } from '../src/sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../src/sessions/session-store-sqlite.ts'
import { HandoffManager } from '../src/sessions/handoff/manager.ts'
import { resolveSessionLocations } from '../src/sessions/locality.ts'
import type { SessionTurnFact } from '../src/sessions/input.ts'
import { Tools } from '../src/tools/registry.ts'
import { ReadTool } from '../src/tools/read.ts'
import { WriteTool } from '../src/tools/filesystem.ts'
import { SearchTool } from '../src/tools/search.ts'
import { ExecTool } from '../src/tools/shell.ts'
import { CommandHandlerManager } from '../src/tools/shell-commands/command-handler.ts'
import { ImportTool } from '../src/tools/load-tool.ts'
import { InvokeTool } from '../src/tools/invoke-tool.ts'
import { registerEventTools } from '../src/tools/event-source.ts'
import { ContinuationTool } from '../src/tools/background.ts'
import { CancelTool } from '../src/tools/cancel.ts'
import { AskTool } from '../src/tools/ask.ts'
import { ReplyTool } from '../src/tools/reply.ts'
import { SubagentTool } from '../src/tools/subagent.ts'
import { MessageTool } from '../src/tools/message.ts'
import { registerCronTools } from '../src/tools/cron.ts'
import { CronService } from '../src/cron/service.ts'
import { CronDispatcher } from '../src/cron/dispatch.ts'
import { VirtualFs } from '../src/vfs/virtual-fs.ts'
import { createBgTasksHandler, createEventsHandler, createSkillsHandler } from '../src/vfs/mounts.ts'
import { createAgentsHandler } from '../src/vfs/agents.ts'
import {
  ACTIONS_RUN_ID, ACTIONS_RUN_PATH, SECOND_RUN_ID, SECOND_RUN_PATH, LIVE_LOG_PATH, actionsFixtureCli,
  createActionsFixture, eventWaitPrompt, type ActionsConclusion,
} from './event-wait-fixture.ts'

export const scenarioSchema = z.enum(['cold', 'existing-source', 'failure'])
export type EventWaitScenario = z.infer<typeof scenarioSchema>
export interface ObservedToolCall {
  at: string
  finishedAt?: string
  name: string
  args: Record<string, unknown>
  result?: string
}

export function eventWaitStrategies(calls: ObservedToolCall[], tasks: Array<{ kind: string }>): string[] {
  const strategies = new Set<string>()
  for (const observed of calls) {
    let call = observed
    if (call.name === 'invoke_tool' && typeof call.args.name === 'string') {
      const args = z.record(z.unknown()).safeParse(call.args.args)
      if (!args.success) { strategies.add('invalid-invocation-arguments'); continue }
      call = { ...call, name: call.args.name, args: args.data }
    }
    if (call.name === 'event_subscribe' && call.args?.action === 'subscribe' &&
      call.result?.startsWith('Subscribed ')) strategies.add('event-subscribe')
    if (call.name === 'event_source' && call.args?.action === 'create' &&
      call.result?.startsWith('Created event source ')) strategies.add('polling-event-source')
    if (call.name === 'cron_add') strategies.add('cron')
    if (call.name === 'subagent') strategies.add('subagent')
    if (call.name === 'github_actions' && call.finishedAt && !call.result?.startsWith('Error') &&
      call.args.action === 'watch') strategies.add('github-actions-run-watch')
    if (call.name === 'github_actions' && call.finishedAt && !call.result?.startsWith('Error') &&
      call.args.action === 'watch_signal') strategies.add('github-actions-signal-watch')
    if (call.name === 'exec' && call.finishedAt && !call.result?.includes('Execution ID: bg:')) {
      strategies.add('foreground-exec')
      if (Date.parse(call.finishedAt) - Date.parse(call.at) >= 10_000) strategies.add('foreground-exec-wait')
    }
  }
  if (tasks.some(task => task.kind === 'process')) strategies.add('background-exec')
  return [...strategies]
}

export function eventWaitVerdict(
  conclusion: ActionsConclusion,
  dispatches: Array<{ accepted: boolean }>,
  attempts: Array<{ accepted: boolean }>,
  facts: Array<Pick<SessionTurnFact, 'status' | 'content'>>,
  observation: {
    firstCompletedAt?: string; thirdStepStatus: string; urlLatencyMs: number | null
  },
  urlTimeoutMs: number,
  finishedAfterCompletion: boolean,
) {
  const violations = []
  if (!observation.firstCompletedAt) violations.push('first-run-never-completed')
  if (!finishedAfterCompletion) violations.push('no-terminal-turn-after-run-completion')
  if (dispatches.some(dispatch => !dispatch.accepted)) violations.push('premature-or-duplicate-dispatch')
  if (attempts.some(attempt => !attempt.accepted)) violations.push('rejected-url-processing')
  if (conclusion === 'success') {
    if (dispatches.filter(dispatch => dispatch.accepted).length !== 1) violations.push('second-run-not-launched-once')
    if (attempts.filter(attempt => attempt.accepted).length !== 1) violations.push('url-not-processed-once')
    if (observation.thirdStepStatus !== 'completed') violations.push('third-step-not-completed')
    if (observation.urlLatencyMs === null || observation.urlLatencyMs >= urlTimeoutMs) violations.push('url-deadline-missed')
  }
  if (conclusion === 'failure' && (dispatches.length !== 0 || attempts.length !== 0)) violations.push('continued-after-failed-first-run')
  if (facts.some(fact => fact.status !== 'completed')) violations.push('agent-turn-failed-or-cancelled')
  if (conclusion === 'failure' && !facts.some(fact => /fail|失败|失敗/i.test(fact.content))) {
    violations.push('failure-not-reported')
  }
  return { passed: violations.length === 0, violations }
}

export type EventWaitFixture = Pick<Awaited<ReturnType<typeof createActionsFixture>>,
  'origin' | 'requests' | 'dispatches' | 'attempts' | 'signals' | 'observation' | 'close'>

export interface ExternalEventWait {
  fixture: EventWaitFixture
  prompt: string
  configure(importer: ImportTool, workdir: string): Promise<void>
  refresh(signal: AbortSignal): Promise<void>
  request?: typeof fetch
}

interface LiveOptions {
  output: string
  scenario: EventWaitScenario
  model: string
  storage: 'jsonl' | 'sqlite'
  holdMs: number
  timeoutMs: number
  maxCalls: number
  urlTimeoutMs: number
  external?: ExternalEventWait
}

export async function runEventWait(options: LiveOptions, liveProvider: LLMProvider) {
  const { scenario, model, storage, holdMs, timeoutMs, maxCalls, urlTimeoutMs } = options
  const output = resolve(options.output)
  await mkdir(output, { recursive: false })
  const workspace = join(output, 'home')
  await mkdir(workspace)
  const simulation = options.external ? undefined : await createActionsFixture({ urlTimeoutMs })
  const fixture = options.external?.fixture ?? simulation
  if (!fixture) throw new Error('Acceptance scenario is missing')
  const started = Date.now()
  const deadline = started + timeoutMs
  const sessionId = 'web:actions-wait'
  const projectId = 'event-wait-acceptance'
  const scope = createProjectScope(projectId)
  const evalBridge = new EvalBridgeRuntime({ projectId, scope })
  const calls: ObservedToolCall[] = []
  const responses: Array<{ at: string; content: unknown; toolCalls: unknown; usage: unknown }> = []
  const facts: Array<SessionTurnFact & { at: string }> = []
  const inputs: Array<{ at: string; source: unknown }> = []
  const waitingSamples: Array<{
    at: string; phase: string; stage: 'first-run' | 'second-run'; processing: boolean; background: unknown; subscriptions: number
  }> = []
  const taskObservations = new Map<string, { kind: string }>()
  let modelCalls = 0
  let runError: string | undefined
  let sessions: SessionManager | undefined
  let sources: PollingSources | undefined
  let cron: CronService | undefined
  let store: JsonlSessionStore | SqliteSessionStore | undefined
  let handoff: HandoffManager | undefined
  const bus = new Bus()
  const events = new EventService(workspace, bus, (id, input) => {
    if (!sessions) throw new Error('Session manager is not ready')
    return sessions.deliver(id, input)
  }, scope)
  const background = new BackgroundTaskManager(bus, events, scope)
  const agentTypes = new AgentTypesManager(workspace)
  const skills = new SkillsManager(workspace)
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('Live evaluation deadline exhausted')), timeoutMs)
  const artifact = (name: string, value: unknown) =>
    writeFile(join(output, name), JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  try {
    await agentTypes.load()
    await skills.load()
    const provider: LLMProvider = {
      name: liveProvider.name,
      listModels: () => liveProvider.listModels(),
      async chat(messages, definitions, chatOptions) {
        controller.signal.throwIfAborted()
        if (modelCalls >= maxCalls) throw new Error('Live evaluation model-call budget exhausted')
        modelCalls++
        const signal = AbortSignal.any([controller.signal, ...(chatOptions.signal ? [chatOptions.signal] : [])])
        const result = await liveProvider.chat(messages, definitions, { ...chatOptions, signal })
        responses.push({ at: new Date().toISOString(), content: result.content, toolCalls: result.toolCalls, usage: result.usage })
        await artifact('model-responses.json', responses)
        return result
      },
    }
    const tools = new Tools(workspace)
    const vfs = new VirtualFs()
    const importer = new ImportTool(new Map(), workspace, undefined, name => skills.getSkillDirectory(name))
    tools.register(new ReadTool(workspace, vfs))
    tools.register(new WriteTool(workspace, false, vfs))
    tools.register(new SearchTool(workspace, undefined, vfs))
    tools.register(new InvokeTool(importer))
    tools.register(new ExecTool(workspace, 30_000, new CommandHandlerManager(), new ProcessManager(), defaultManagedShell(), background))
    tools.addHook({
      name: 'acceptance-observation',
      async beforeExecute(name, args) { calls.push({ at: new Date().toISOString(), name, args: structuredClone(args) }) },
      async afterExecute(name, args, result) {
        const call = calls.findLast(item => item.name === name && !item.finishedAt &&
          JSON.stringify(item.args) === JSON.stringify(args))
        if (call) { call.finishedAt = new Date().toISOString(); call.result = result }
        await artifact('tool-calls.json', calls)
        return undefined
      },
    })
    const identity = new IdentityManager(workspace)
    const config = ConfigSchema.parse({ agent: { workspace, model }, channels: {} })
    const context = new ContextBuilder(workspace)
    const runtime = {
      projectId, identity,
      getSkillsSummary: (admin: boolean, id?: string) => skills.getMetadataSummary(admin, id) || '',
      getAgentTypesSummary: () => agentTypes.getAgentTypesSummary(),
    }
    context.register(runtimeIdentityProvider(runtime))
    context.register(executionContractProvider())
    context.register(workspaceProvider(workspace, vfs))
    context.register(guidelineProvider())
    context.register(runtimeDiscoveryProvider(runtime))
    store = storage === 'sqlite' ? new SqliteSessionStore(projectStoragePath(workspace, '.sessions'))
      : new JsonlSessionStore(projectStoragePath(workspace, '.sessions'))
    await store.init()
    const contextWindow = resolveContextWindow(model)
    handoff = new HandoffManager(provider, contextWindow, { autoHandoff: false }, workspace, store)
    sessions = new SessionManager({
      projectId, scope, workspace, store, provider, tools, toolLoader: importer, context, evalBridge,
      identity, bus, events, agentTypes, backgroundTasks: background, handoffManager: handoff,
      getLlmRuntimeConfig: () => ({
        model, contextWindow, temperature: config.agent.temperature,
        thinking: config.agent.thinking, reasoningEffort: config.agent.reasoningEffort,
      }),
      defaultExecShell: defaultManagedShell(),
    })
    const manager = sessions
    const canAuthor = (id: string) => manager.getSessionState(id)?.mode === 'session'
    const broker = new CapabilityBroker({
      projectId, directory: join(workspace, '.receipts'),
      resolveSecret: async () => undefined,
      canDeliver: canAuthor, deliver: (id, input) => manager.deliver(id, input),
      request: async (url, init) => {
        if (options.external?.request) return options.external.request(url, init)
        const parsed = new URL(String(url))
        const allowed = parsed.origin === 'https://api.github.com' &&
          [ACTIONS_RUN_PATH, SECOND_RUN_PATH].includes(parsed.pathname) ||
          parsed.origin === 'https://actions-fixture.example' && parsed.pathname === LIVE_LOG_PATH
        if (!allowed || (init?.method ?? 'GET') !== 'GET') throw new Error('Only synthetic run and live-log read routes are available')
        return fetch(fixture.origin + parsed.pathname + parsed.search, init)
      },
    })
    sources = new PollingSources(workspace, events, broker, canAuthor, () => false)
    registerEventTools(importer, events, sources, canAuthor)
    cron = new CronService(workspace, 'UTC', scope)
    const dispatcher = new CronDispatcher(manager, async (job, targetSessionId, signal) => {
      signal.throwIfAborted()
      const event = job.event ?? { type: 'cron-tick', source: 'cron', content: job.task ?? '' }
      await events.emit({
        type: event.type, source: event.source ?? 'cron', content: event.content, targetSessionId,
        delivery: event.delivery, meta: { ...event.meta, 'cron-id': job.id, schedule: job.schedule },
        origin: job.originSessionId ? {
          sessionId: job.originSessionId, inputId: job.id,
          source: { kind: 'session', sessionId: job.originSessionId },
        } : undefined,
      })
    })
    cron.setHandler(async (job, signal) => { await dispatcher.dispatch(job, signal) })
    registerCronTools(importer, cron, manager, name => agentTypes.resolve(name) !== null)
    tools.register(new ContinuationTool(background, manager))
    tools.register(new CancelTool(manager, undefined, background))
    tools.register(new AskTool(manager.yields, manager.inputs))
    tools.register(new ReplyTool(manager.yields, manager.inputs))
    const channels = new ChannelManager(config,
      bus, manager, message => manager.deliver(sessionId, {
        kind: 'message', id: message.messageId, timestamp: message.timestamp, content: message.content, policy: 'queue',
        source: { kind: 'user', sender: message },
      }))
    tools.register(new SubagentTool(bus, manager, agentTypes, channels))
    tools.register(new MessageTool(bus, id => manager.canReceiveSessionMessage(id),
      id => manager.getSessionState(id)?.parent, id => manager.getSessionState(id)?.children,
      (id, input) => manager.deliver(id, input), (source, target) => manager.canSendSessionMessage(source, target)))
    for (const [prefix, description, handlers] of [
      ['v:tools', 'discoverable tool contracts', {
        read: (name, ctx) => importer.readVirtual(name, ctx),
        list: (ctx, options) => importer.virtualEntries(ctx, options),
      }],
      ['v:skills', 'skill bodies and category listings', createSkillsHandler(skills, (skill, ctx) => importer.registerSkillTools(skill, ctx))],
      ['v:events', 'event subscriptions and registered sources', createEventsHandler(events)],
      ['v:bg', 'owned executions and output', createBgTasksHandler(background, manager)],
      ['v:agents', 'available local roles', createAgentsHandler(agentTypes)],
    ] satisfies Array<[string, string, { read: import('../src/vfs/virtual-fs.ts').VirtualFsHandler; list: import('../src/vfs/virtual-fs.ts').VirtualFsListHandler }]>) {
      vfs.mount(prefix, description, handlers.read, handlers.list)
    }
    bus.on('session.turn.finished', fact => {
      if (fact.sessionId !== sessionId) return
      facts.push({ ...fact, at: new Date().toISOString() })
      console.log(`[event-wait] ${scenario}: turn ${fact.status} (${fact.source.kind})`)
    })
    bus.on('session.input.accepted', fact => inputs.push({ at: new Date().toISOString(), source: fact.input.source }))
    await events.start()
    sources.start()
    await cron.start()
    await manager.start()
    await manager.buildSession(sessionId, undefined, { mode: 'session', agentType: 'general', sessionKind: 'topic' })
    const state = manager.getSessionState(sessionId)
    if (!state) throw new Error('Acceptance session was not created')
    const locations = resolveSessionLocations(workspace, state)
    if (!locations.workdir.available || locations.workdir.locality !== 'local') throw new Error('Expected local managed workdir')
    await mkdir(locations.workdir.path, { recursive: true })
    if (options.external) await options.external.configure(importer, locations.workdir.path)
    else await writeFile(join(locations.workdir.path, 'actions-fixture.mjs'), actionsFixtureCli(fixture.origin))
    if (scenario === 'existing-source') {
      events.registerSource({
        source: 'custom:actions-fixture', kind: 'custom',
        description: `Emits github.actions.completed with run JSON for fixture/actions runs ${ACTIONS_RUN_ID} and ${SECOND_RUN_ID}, and github.actions.log with new live log lines including PROCESS_URL during step 3.`,
      })
    }
    const prompt = options.external?.prompt ?? eventWaitPrompt(fixture.origin, urlTimeoutMs)
    await artifact('prompt.json', {
      prompt, model, storage, scenario, holdMs, timeoutMs, maxCalls, urlTimeoutMs,
      temperature: config.agent.temperature, thinking: config.agent.thinking, reasoningEffort: config.agent.reasoningEffort,
    })
    await manager.deliver(sessionId, {
      kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), content: prompt, policy: 'queue',
      source: { kind: 'user', sender: { channel: 'web', chatId: 'actions-wait', senderId: 'fixture-owner', messageId: crypto.randomUUID() } },
    })
    const completeAfter = Date.now() + holdMs
    const conclusion: ActionsConclusion = scenario === 'failure' ? 'failure' : 'success'
    let emitted = 0
    let idleSince: number | undefined
    while (Date.now() < deadline) {
      if (options.external) await options.external.refresh(controller.signal)
      if (simulation && !fixture.observation().firstCompletedAt && Date.now() >= completeAfter) {
        simulation.complete(conclusion)
        console.log(`[event-wait] ${scenario}: first run completed (${conclusion})`)
      }
      while (scenario === 'existing-source' && emitted < fixture.signals.length) {
        const signal = fixture.signals[emitted++]
        await events.emit({ ...signal, source: 'custom:actions-fixture' })
      }
      const observation = fixture.observation()
      const tasks = background.listTasks(sessionId)
      for (const task of tasks) taskObservations.set(task.id, { kind: task.kind })
      const phase = manager.getActiveSession(sessionId)?.phase ?? 'idle'
      if (!observation.secondCompletedAt) waitingSamples.push({
        at: new Date().toISOString(), phase, stage: observation.secondStartedAt ? 'second-run' : 'first-run',
        processing: phase !== 'idle',
        background: tasks, subscriptions: events.list(sessionId).length,
      })
      const finishedAt = conclusion === 'failure' ? observation.firstCompletedAt : observation.secondCompletedAt
      if (finishedAt && facts.some(fact => Date.parse(fact.at) >= Date.parse(finishedAt)) &&
        phase === 'idle' && tasks.every(task => ['completed', 'failed', 'cancelled'].includes(task.status))) {
        idleSince ??= Date.now()
        if (Date.now() - idleSince >= 2000) break
      } else {
        idleSince = undefined
      }
      if (facts.some(fact => fact.status !== 'completed')) break
      await delay(250, undefined, { signal: controller.signal })
    }
    if (Date.now() >= deadline) throw new Error('Live evaluation deadline exhausted')
  } catch (error) {
    runError = error instanceof Error ? error.message : String(error)
    console.error(`[event-wait] ${scenario}: ${runError}`)
  } finally {
    clearTimeout(timer)
    controller.abort()
    await sources?.stop()
    await cron?.stop()
    await sessions?.stop()
    await background.stop()
    await events.stop()
    await evalBridge.shutdown()
    await handoff?.stop()
    await agentTypes.stopWatching()
    await skills.stopWatching()
    bus.stopAll()
    let history: ChatMessage[] = []
    if (sessions) history = (await sessions.getHistory(sessionId, { maxMessages: Number.MAX_SAFE_INTEGER })).messages
    const observation = fixture.observation()
    const completedAt = scenario === 'failure' ? observation.firstCompletedAt : observation.secondCompletedAt
    const conclusion: ActionsConclusion = scenario === 'failure' ? 'failure' : 'success'
    const verdict = eventWaitVerdict(conclusion, fixture.dispatches, fixture.attempts, facts, observation, urlTimeoutMs,
      !!completedAt && facts.some(fact => Date.parse(fact.at) >= Date.parse(completedAt)))
    const summary = {
      scenario, model, storage, modelCalls, elapsedMs: Date.now() - started,
      ...verdict, ...(runError ? { passed: false, error: runError } : {}),
      strategies: eventWaitStrategies(calls, [...taskObservations.values()]),
      ...observation, urlTimeoutMs, dispatches: fixture.dispatches, urlProcessingAttempts: fixture.attempts,
      firstRunToDispatchMs: observation.firstCompletedAt && observation.secondStartedAt
        ? Date.parse(observation.secondStartedAt) - Date.parse(observation.firstCompletedAt) : null,
      apiRequests: fixture.requests.length,
      logReadRequests: fixture.requests.filter(request => request.path.startsWith(LIVE_LOG_PATH)).length,
      acceptedEventTypes: inputs.flatMap(input => {
        const source = input.source
        return source && typeof source === 'object' && 'kind' in source && source.kind === 'event' &&
          'type' in source ? [source.type] : []
      }),
      subscriptions: events.list(sessionId),
      pollingSources: sources?.list(sessionId),
      waitingSamples: waitingSamples.length,
      idleWaitingSamples: waitingSamples.filter(sample => !sample.processing).length,
    }
    await artifact('summary.json', summary)
    await artifact('trace.json', { calls, responses, facts, inputs, waitingSamples, requests: fixture.requests, signals: fixture.signals })
    await artifact('history.json', history)
    if (store instanceof SqliteSessionStore) store.close()
    await fixture.close()
    scope.close()
  }
  return z.object({
    passed: z.boolean(), modelCalls: z.number(), strategies: z.array(z.string()),
    urlLatencyMs: z.number().nullable(), violations: z.array(z.string()),
  }).parse(JSON.parse(await readFile(join(output, 'summary.json'), 'utf8')))
}

async function main() {
  if (process.env.SHADOW_EVENT_WAIT_LIVE !== '1') {
    throw new Error('Set SHADOW_EVENT_WAIT_LIVE=1 to authorize a live, potentially billable model test')
  }
  const { values } = parseArgs({ options: {
    out: { type: 'string' }, scenario: { type: 'string', default: 'cold' },
    model: { type: 'string', default: DEFAULT_COPILOT_MODEL },
    storage: { type: 'string', default: 'sqlite' },
    'hold-seconds': { type: 'string', default: '90' },
    'timeout-seconds': { type: 'string', default: '360' },
    'max-calls': { type: 'string', default: '30' },
    'url-timeout-seconds': { type: 'string', default: '60' },
  } })
  if (!values.out) throw new Error('Usage: node --import tsx scripts/event-wait-acceptance.ts --out <new directory> [--scenario cold|existing-source|failure]')
  const holdMs = z.coerce.number().int().min(30).max(180).parse(values['hold-seconds']) * 1000
  const timeoutMs = z.coerce.number().int().min(60).max(900).parse(values['timeout-seconds']) * 1000
  if (timeoutMs <= holdMs + 30_000) throw new Error('Timeout must leave more than 30 seconds after run completion')
  const provider = new CopilotProviderV2()
  if (!(await provider.listModels()).includes(values.model)) throw new Error(`Copilot model ${values.model} is unavailable`)
  const result = await runEventWait({
    output: values.out, scenario: scenarioSchema.parse(values.scenario), model: values.model,
    storage: z.enum(['jsonl', 'sqlite']).parse(values.storage), holdMs, timeoutMs,
    maxCalls: z.coerce.number().int().min(1).max(100).parse(values['max-calls']),
    urlTimeoutMs: z.coerce.number().int().min(1).max(120).parse(values['url-timeout-seconds']) * 1000,
  }, provider)
  console.log(JSON.stringify({ ...result, summary: join(resolve(values.out), 'summary.json') }))
  if (!result.passed) process.exitCode = 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
