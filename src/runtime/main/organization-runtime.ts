import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile as nodeWriteFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { AgentTypesManager } from '../../agent/types/manager.ts'
import { AgentApp } from '../../agent/app.ts'
import { BackgroundTaskManager } from '../../agent/background-task.ts'
import { ContextBuilder } from '../../agent/context/builder.ts'
import { guidelineProvider } from '../../agent/context/guideline.ts'
import { projectProvider } from '../../agent/context/project.ts'
import { memoryProvider } from '../../agent/context/memory-provider.ts'
import { runtimeIdentityProvider } from '../../agent/context/runtime.ts'
import { workspaceProvider } from '../../agent/context/workspace.ts'
import { IdentityManager } from '../../agent/identity.ts'
import type { LlmRuntimeConfig } from '../../agent/llm-config.ts'
import { MemoryStore } from '../../agent/memory.ts'
import { agentTypesPlugin } from '../../agent/types/routes.ts'
import { createConfigCommand } from '../../slash-commands/handlers/config.ts'
import { createYieldCommand } from '../../slash-commands/handlers/yield.ts'
import { createDumpPromptCommand } from '../../slash-commands/handlers/dump-prompt.ts'
import { createHelpCommand } from '../../slash-commands/handlers/help.ts'
import { createLearnCommand } from '../../slash-commands/handlers/learn.ts'
import { triggerReflectorFlush } from '../../agent/learning/pipelines.ts'
import { createCompactCommand } from '../../slash-commands/handlers/compact.ts'
import { createSessionsCommand } from '../../slash-commands/handlers/sessions.ts'
import { createStatusCommand } from '../../slash-commands/handlers/status.ts'
import { CommandDispatcher } from '../../slash-commands/index.ts'
import type { Config, McpServerConfig } from '../../config/schema.ts'
import { HandoffManager } from '../../sessions/handoff/manager.ts'
import { McpManager } from '../../mcp/manager.ts'
import { SessionManager } from '../../sessions/session-manager.ts'
import { JsonlSessionStore } from '../../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../../sessions/session-store.ts'
import { localProjectWorkdirRef, type WorkdirCapabilityLookup } from '../../sessions/locality.ts'
import { ProjectError, ProjectRegistry } from '../../projects/registry.ts'
import { ProjectService } from '../../projects/routes.ts'
import { projectAccessMiddleware } from '../../projects/access.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { BackgroundTaskTool, ContinuationTool } from '../../tools/background.ts'
import { CommandHandlerManager } from '../../tools/shell-commands/command-handler.ts'
import { createUserLinkCommandHandler } from '../../tools/shell-commands/userlink.ts'
import { CronTool } from '../../tools/cron.ts'
import { LogTool } from '../../tools/log.ts'
import { EventSubscribeTool } from '../../tools/event-subscribe.ts'
import { WriteTool } from '../../tools/filesystem.ts'
import type { LoadableEntry, McpLoadable } from '../../tools/load-tool.ts'
import { InvokeTool } from '../../tools/invoke-tool.ts'
import { ImportTool } from '../../tools/load-tool.ts'
import { MemoryLinkCheckHook } from '../../tools/hooks/memory-link-checker.ts'
import { WorkingSetHook } from '../../tools/hooks/working-set.ts'
import { ConventionTool } from '../../tools/convention.ts'
import { MessageTool } from '../../tools/message.ts'
import { PlanWriteTool } from '../../tools/plan-write.ts'
import { ProcessManager } from '../../execution/processes/manager.ts'
import { ProjectTool } from '../../tools/project.ts'
import { ReadTool } from '../../tools/read.ts'
import { Tools } from '../../tools/registry.ts'
import { ExecTool } from '../../tools/shell.ts'
import { SubagentTool } from '../../tools/subagent.ts'
import { YieldTool } from '../../tools/yield.ts'
import { remoteSessionPlugin } from '../../sessions/remote-session-routes.ts'
import { RemoteProjectOwnership } from '../../projects/remote-ownership.ts'
import {
  createBgTasksHandler,
  createEventsHandler,
  createMemoryHandler,
  createSessionsHandler,
  createSkillsHandler,
} from '../../vfs/mounts.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'

import { Bus } from '../../bus/bus.ts'
import { ChannelManager } from '../../channels/manager.ts'
import { botSetupPlugin } from '../../channels/bot-setup.ts'
import { BotInstanceStore } from '../../channels/bot-store.ts'
import { organizationConfigPlugin } from '../../organizations/config-routes.ts'
import { EventService } from '../../events/service.ts'
import { CronService } from '../../cron/service.ts'

import { OtelStore } from '../../otel/store.ts'
import { initializeNodeTelemetry } from '../../otel/runtime.ts'
import { otelPlugin } from '../../otel/routes.ts'
import {
  createAggregatedProvider,
  detectProvider,
} from '../../providers/factory.ts'
import { parseModelSpec } from '../../providers/aggregated.ts'
import { MODEL_CONTEXT_WINDOWS, resolveContextWindow } from '../../providers/model-registry.ts'
import { providerPlugin } from '../../providers/routes.ts'
import { sessionsApiPlugin } from '../../sessions/routes.ts'
import { registerEvalBridgeRoute } from '../../script-runtime/bridge.ts'
import { SearchTool } from '../../tools/search.ts'
import {
  detectSearXNG,
  FirecrawlSearchTool,
  SearXNGSearchTool,
  WebSearchTool,
} from '../../tools/web.ts'
import { ChromeManager } from '../../browser/chrome-manager.ts'
import { cleanupTempFiles, workspacePath } from '../../utils/paths.ts'
import { isCronEventPayload, isCronEventTarget } from '../../cron/events.ts'
import type { OrganizationRuntime, OrganizationRuntimeDependencies } from '../../organizations/runtime.ts'
import { migrateSessionOrganizations } from '../../organizations/session-migration.ts'
import { EvalBridgeRuntime } from '../../script-runtime/bridge.ts'
import { DEFAULT_ORGANIZATION_ID } from '../../organizations/contracts.ts'
import { OrganizationExecutor } from '../../organizations/executor.ts'
import { LearningService } from '../../agent/learning/service.ts'

function resolvePrimaryProviderName(modelSpec: string): string {
  const { model, provider } = parseModelSpec(modelSpec)
  return provider ?? detectProvider(model)
}

function createLlmRuntimeConfig(config: Config): LlmRuntimeConfig {
  const { model: bareModel } = parseModelSpec(config.agent.model)
  const primaryProvider = resolvePrimaryProviderName(config.agent.model)
  const providerConfig = config.providers[primaryProvider]

  return {
    model: config.agent.model,
    temperature: config.agent.temperature,
    contextWindow: resolveContextWindow(bareModel, {
      modelContextWindows: providerConfig?.modelContextWindows,
    }),
    thinking: config.agent.thinking,
    reasoningEffort: config.agent.reasoningEffort,
  }
}

export async function createOrganizationRuntime(
  config: Config,
  dependencies: OrganizationRuntimeDependencies,
): Promise<OrganizationRuntime> {
  const { scope, organization, mainCluster, copilotAuth, configStore } = dependencies
  const workspace = config.agent.workspace
  const selfCodeRoot = dependencies.selfCodeRoot
  const cleanup: Array<() => unknown> = []

  // ── Create core components ────────────────────────────────
  const bus = new Bus()
  cleanup.push(() => bus.stopAll())
  bus.declareQueue('message.outbound')
  let deliverInput: import('../../sessions/input.ts').DeliverInput = async () => {
    throw new Error('Session delivery is not ready')
  }
  const events = new EventService(workspace, bus, (sessionId, input) => deliverInput(sessionId, input))
  cleanup.push(() => events.stop())
  let provider = createAggregatedProvider(config, copilotAuth)
  let activeConfig = config
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  cleanup.push(() => backgroundTasks.stop())

  // OTel ingest/query store (formerly the standalone observer in app/)
  const otelDbPath = workspacePath(workspace, '.otel.db')
  const otelStore = new OtelStore(otelDbPath)
  const telemetry = initializeNodeTelemetry(otelStore, { scope, organizationId: organization.id })
  let telemetryShutdown: Promise<void> | undefined
  const closeTelemetry = () => {
    telemetryShutdown ??= telemetry.shutdown().finally(() => otelStore.close())
    return telemetryShutdown
  }
  console.info(`[main] OTel store: ${otelDbPath}`)
  console.info(`[organization:${organization.id}] Starting: workspace=${workspace}, model=${config.agent.model}`)

  cleanup.push(closeTelemetry)
  try {
    await events.start()
    return await startServices()
  } catch (error) {
    for (const close of cleanup.reverse()) {
      try { await close() } catch (cleanupError) { console.error('[organization] Startup cleanup failed', cleanupError) }
    }
    throw error
  }

  async function startServices(): Promise<OrganizationRuntime> {
  // ── Build tool registry ─────────────────────────────────────────────
  const vfs = new VirtualFs()
  const tools = new Tools(workspace)
  tools.register(new ReadTool(workspace, vfs))
  tools.register(
    new WriteTool(
      workspace,
      selfCodeRoot,
      config.tools.restrictToWorkspace,
    ),
  )
  tools.register(new PlanWriteTool(workspace))

  // ── Execution hooks ───────────────────────────────────────────────
  tools.addHook(new MemoryLinkCheckHook(workspace))

  const identity = new IdentityManager(workspace, organization.id)

  // ── Create gateway app early so we can pass it to Agent ──
  const app = new Hono()
  app.use('*', (_c, next) => scope.run(next))
  const evalBridge = new EvalBridgeRuntime({ organizationId: organization.id, scope, gatewayBaseUrl: dependencies.gatewayBaseUrl })
  cleanup.push(() => evalBridge.shutdown())
  const projectRegistry = new ProjectRegistry(resolve(workspace), { organizationId: organization.id, catalog: dependencies.catalog })
  await projectRegistry.init()
  app.use('*', projectAccessMiddleware(projectRegistry))
  const ownsWorkdir = (ref: import('../../sessions/locality.ts').WorkdirRefV1): boolean => {
    if (projectRegistry.lookupWorkdir(ref)?.capability) return true
    if (projectRegistry.ownsRemoteWorkdir(ref)) return true
    if (projectRegistry.isRetiredWorkdir(ref)) return false
    return sessions.listSessions().some(session => {
      const workdir = sessions.getSessionState(session.sessionId)?.workdir
      return workdir?.nodeId === ref.nodeId && workdir.capabilityId === ref.capabilityId
    })
  }
  const workdirCapabilityLookup: WorkdirCapabilityLookup = ref =>
    projectRegistry.lookupWorkdir(ref) ?? (ownsWorkdir(ref) ? mainCluster.workdirCapabilityLookup(ref) : { node: 'online' })
  const remoteExecutor = new OrganizationExecutor(organization.id, mainCluster.remoteExecutor, request => {
    if (request.sessionId === `project-identity:${organization.id}` && request.operation === 'workdir.identity') return
    if (request.sessionId.startsWith('project:')) {
      if (!projectRegistry.get(request.sessionId.slice('project:'.length))) {
        throw new ProjectError('project_access_revoked', 'This folder is no longer available to this organization.', 409)
      }
    } else {
      sessions.assertProjectAccess(request.sessionId)
    }
    if (!ownsWorkdir({ version: 1, nodeId: request.nodeId, capabilityId: request.capabilityId })) {
      throw new ProjectError('project_access_revoked', 'This folder is no longer available to this organization.', 409)
    }
  }, (jobId, pending) => dependencies.catalog.recordRemoteJob(organization.id, jobId, pending))
  projectRegistry.configureRemote(new RemoteProjectOwnership({
    organizationId: organization.id,
    catalog: dependencies.catalog,
    executor: remoteExecutor,
    lookup: mainCluster.workdirCapabilityLookup,
    capability: ref => mainCluster.registry.listCapabilities(ref.nodeId).find(capability => capability.capabilityId === ref.capabilityId),
  }))

  const execConfig = config.tools.exec

  const commandHandler = new CommandHandlerManager()
  const processManager = new ProcessManager()
  commandHandler.register(
    'userlink',
    createUserLinkCommandHandler(workspace, identity, bus),
  )

  tools.register(
    new ExecTool(
      workspace,
      execConfig?.timeoutMs,
      commandHandler,
      processManager,
      execConfig?.defaultShell,
      backgroundTasks,
    ),
  )

  // Web search provider for the `search` tool's `web:` scheme.
  // Not registered as a standalone tool — only wired into SearchTool below.
  // Firecrawl takes precedence over Brave when both keys are configured.
  let webSearchTool: import('../../tools/tool.ts').Tool | undefined
  if (config.tools.firecrawlApiKey) {
    webSearchTool = new FirecrawlSearchTool(config.tools.firecrawlApiKey)
  } else if (config.tools.braveApiKey) {
    webSearchTool = new WebSearchTool(config.tools.braveApiKey)
  }

  const loadable = new Map<string, LoadableEntry>()
  const searxngFactory = async () => {
    const base = await detectSearXNG()
    if (!base) {
      throw new Error(
        'No reachable SearXNG instance found on localhost or the docker-compose host `searxng`.',
      )
    }
    return new SearXNGSearchTool(base)
  }

  try {
    const searxng = await searxngFactory()
    // tools.register(searxng)
    if (!webSearchTool) webSearchTool = searxng
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.info(`[main] SearXNG eager load skipped: ${message}`)
  }

  // Zero-config fallback: keyless Firecrawl works without an API key when no
  // other web search provider (Brave key or local SearXNG) is available.
  // See https://www.firecrawl.dev/blog/firecrawl-keyless-launch
  if (!webSearchTool) {
    webSearchTool = new FirecrawlSearchTool()
  }

  // SearXNG web search �?eager-loaded when reachable, still lazy-loadable later.
  loadable.set('web_search', {
    factory: searxngFactory,
  })

  // Chrome DevTools MCP — two loadable entries for progressive disclosure:
  //   chrome-devtools      → common tools (input, navigation, snapshot)
  //   chrome-devtools-full → remaining tools (emulation, performance, network, console)
  const chromeDevToolsConfig: McpServerConfig = {
    name: 'chrome-devtools',
    transport: 'stdio',
    command: 'npx',
    args: ['chrome-devtools-mcp@latest'],
  }
  const chromeDevToolsConfigPath = workspacePath(
    workspace,
    '.chrome-devtools.json',
  )
  // Chrome config getter that re-reads from the config file so edits take effect
  // without a process restart (e.g. user sets tools.chrome.executablePath).
  const chromeConfigGetter = (): {
    executablePath?: string
    basePort: number
  } => {
    return activeConfig.tools.chrome ?? { basePort: 9222 }
  }
  const chromeManager = new ChromeManager(workspace, chromeConfigGetter, {
    organizationId: organization.id, portAllocator: dependencies.chromePortAllocator,
  })
  cleanup.push(() => chromeManager.releaseAll())
  const chromeDevToolsEntry: McpLoadable = {
    config: chromeDevToolsConfig,
    configPath: chromeDevToolsConfigPath,
    chromeManager,
    toolFilter: new Set([
      // input
      'click',
      'drag',
      'fill',
      'fill_form',
      'handle_dialog',
      'hover',
      'press_key',
      'type_text',
      'upload_file',
      // navigation
      'close_page',
      'list_pages',
      'navigate_page',
      'new_page',
      'select_page',
      'wait_for',
      // snapshot
      'evaluate_script',
      'take_snapshot',
      'take_screenshot',
    ]),
  }
  loadable.set('chrome-devtools', chromeDevToolsEntry)
  loadable.set('chrome-devtools-full', {
    config: chromeDevToolsConfig,
    configPath: chromeDevToolsConfigPath,
    sharedConn: chromeDevToolsEntry,
  })

  const importTool = new ImportTool(loadable, workspace, chromeManager)
  tools.register(new SearchTool(workspace, webSearchTool, vfs, importTool))
  tools.register(importTool)
  tools.register(new InvokeTool(importTool))

  tools.register(new BackgroundTaskTool(backgroundTasks))
  tools.register(new ContinuationTool(backgroundTasks))
  tools.register(new LogTool(workspace))

  loadable.set('project', new ProjectTool(workspace))

  // Purge stale tool-result temp files from previous runs
  await cleanupTempFiles(workspace)

  // ── Heartbeat pulse ────────────────────────────────────────────
  const pulsePath = workspacePath(workspace, 'HEARTBEAT.pulse')
  const writePulse = async () => {
    try {
      await nodeWriteFile(pulsePath, new Date().toISOString())
    } catch { /* ignore */ }
  }
  await writePulse()
  const pulseTimer = setInterval(writePulse, 60_000)
  cleanup.push(() => clearInterval(pulseTimer))
  bus.emit('app.lifecycle', { action: 'start' })

  // ── Create agent services ───────────────────────────────────────────
  const primaryProvider = resolvePrimaryProviderName(config.agent.model)
  const quickModel = config.agent.quickModel
  let llm = createLlmRuntimeConfig(config)

  const memory = new MemoryStore(workspace)
  tools.addHook(new WorkingSetHook(memory))
  tools.register(new ConventionTool(memory))
  const skills = new SkillsManager(workspace)
  const agentTypes = new AgentTypesManager(workspace)
  cleanup.push(() => skills.stopWatching())
  cleanup.push(() => agentTypes.stopWatching())
  const sessionsDir = workspacePath(workspace, '.sessions')
  const sessionStore: SessionStore = config.agent.sessionStorage === 'sqlite'
    ? new SqliteSessionStore(sessionsDir)
    : new JsonlSessionStore(sessionsDir)

  await sessionStore.init()
  cleanup.push(() => sessionStore.close?.())
  await migrateSessionOrganizations(sessionStore, organization.id)

  const handoffManager = new HandoffManager(
    provider,
    llm.contextWindow,
    {
      model: config.agent.model,
      autoHandoff: config.agent.autoHandoff,
      handoffMinThreshold: config.agent.handoffMinThreshold,
      handoffMaxThreshold: config.agent.handoffMaxThreshold,
    },
    workspace,
    sessionStore,
  )
  cleanup.push(() => handoffManager.stop())

  const context = new ContextBuilder(workspace)
  const sessions: SessionManager = new SessionManager({
    organizationId: organization.id,
    scope,
    ownsProject: id => !!projectRegistry.get(id),
    ownsWorkdir,
    assertSessionProject: state => projectRegistry.assertSessionProject(state),
    acquireProjectAccess: () => projectRegistry.acquireAccess(),
    evalBridge,
    workspace,
    store: sessionStore,
    handoffManager,
    bus,
    provider,
    tools,
    identity,
    context,
    quickModel,
    defaultExecShell: execConfig?.defaultShell,
    honoApp: app,
    backgroundTasks,
    agentTypes,
    events,
    getLlmRuntimeConfig: () => llm,
    getYieldPolicy: () => activeConfig.tools.yield ?? { timeoutMs: null },
    deliverYield: message => channels.deliverDecision(message),
    getKnownContextWindow: (modelSpec) => {
      const { model } = parseModelSpec(modelSpec)
      const provider = resolvePrimaryProviderName(modelSpec)
      return activeConfig.providers[provider]?.modelContextWindows?.[model] ??
        MODEL_CONTEXT_WINDOWS[model] ?? null
    },
    workdirCapabilityLookup,
    remoteExecutor,
    getNodeInventory: () => {
      const inventory = mainCluster.getNodeInventory()
      return {
        ...inventory,
        nodes: inventory.nodes.map(node => ({
          ...node,
          capabilities: node.capabilities.filter(capability => capability.kind !== 'workdir' ||
            ownsWorkdir({ version: 1, nodeId: node.role === 'main' ? 'local' : node.nodeId, capabilityId: capability.capabilityId })),
        })).filter(node => node.role === 'main' || node.capabilities.some(capability => capability.kind === 'workdir')),
      }
    },
    onSessionStopped: (id) => backgroundTasks.handleSessionStopped(id),
  })
  cleanup.push(() => sessions.stop())
  deliverInput = (sessionId, input) => sessions.deliver(sessionId, input)

  context.register(guidelineProvider())
  context.register(
    workspaceProvider(workspace, vfs, workdirCapabilityLookup),
  )
  context.register(runtimeIdentityProvider({
    organizationId: organization.id,
    identity,
    getOrganizationNodeInventory: id => id === organization.id ? sessions.getNodeInventory() : undefined,
    getSkillsSummary: (admin) => skills.getMetadataSummary(admin) || '',
    getAgentTypesSummary: () => agentTypes.getAgentTypesSummary(),
    getChannelCapabilities: (channel, chatId, address) => channels.getCapabilities(channel, chatId, address),
    getActiveSubagents: (parentSessionId) =>
      sessions.getChildren(parentSessionId) ?? Promise.resolve([]),
  }))
  context.register(projectProvider(workspace))
  context.register(memoryProvider(
    memory,
    (sid) => sessions.getSessionState(sid)?.projectName ?? undefined,
  ))

  const mcpManager = new McpManager(
    servers => importTool.updateMcpServers(servers), config.mcp.servers, configStore.configPath,
  )
  cleanup.push(() => mcpManager.stopWatching())

  // ── Virtual filesystem mounts ─────────────────────────────────────────

  vfs.mount(
    'v:tools',
    'discover dynamic tool and MCP sources without connecting; use search with space tools:<name> for current tool contracts',
    (name, context) => importTool.readCatalog(name, context.tools),
    context => importTool.catalogEntries(context.tools),
  )

  const sessionsVfs = createSessionsHandler(sessions)
  vfs.mount(
    'v:sessions',
    'conversation history for all sessions',
    sessionsVfs.read,
    sessionsVfs.list,
  )

  const bgVfs = createBgTasksHandler(backgroundTasks)
  vfs.mount('v:bg', 'background task status and output', bgVfs.read, bgVfs.list)

  const skillsVfs = createSkillsHandler(skills)
  vfs.mount(
    'v:skills',
    'read skill bodies and category listings',
    skillsVfs.read,
  )

  const memoryVfs = createMemoryHandler(workspace)
  vfs.mount(
    'v:memory',
    'read, search, and write your long-term memory store',
    memoryVfs.read,
    memoryVfs.list,
  )

  const eventsVfs = createEventsHandler(events)
  vfs.mount(
    'v:events',
    "list this session's event subscriptions",
    eventsVfs.read,
    eventsVfs.list,
  )

  // ── Create agent loop ──────────────────────────────────────────────
  const commandDispatcher = new CommandDispatcher()
  const agent = new AgentApp({
    identity,
    bus,
    sessions,
    skills,
    mcpManager,
    commandDispatcher,
    agentTypes,
    events,
    getLlmRuntimeConfig: () => llm,
  })

  commandDispatcher.register(createHelpCommand(commandDispatcher))
  commandDispatcher.register(createConfigCommand(sessions))
  commandDispatcher.register(createYieldCommand(sessions))
  commandDispatcher.register(createCompactCommand(sessions))
  commandDispatcher.register(createDumpPromptCommand(agent))
  commandDispatcher.register(createStatusCommand(sessions))
  commandDispatcher.register(createSessionsCommand(agent))
  commandDispatcher.register(createLearnCommand(sessions))

  tools.register(
    new MessageTool(
      bus,
      (id) => sessions.canReceiveSessionMessage(id),
      (id) => {
        const owner = sessions.getDelegationOwner(id)
        return owner ? { id: owner } : undefined
      },
      (parentId) => sessions.getSessionState(parentId)?.children,
      deliverInput,
      (source, target) => sessions.canSendSessionMessage(source, target),
    ),
  )
  tools.register(new YieldTool(sessions.yields))

  // ── Cron service ──────────────────────────────────────────────────
  const cronService = new CronService(workspace, config.cron.timezone)
  cronService.setHandler(async (job) => {
    const legacySessionId = `${job.channel ?? 'cron'}:${job.chatId ?? job.id}`
    const targetSessionId = job.isolated
      ? `cron:${job.id}`
      : isCronEventTarget(job.target)
      ? job.target.sessionId
      : legacySessionId
    const event = isCronEventPayload(job.event) ? job.event : {
      type: 'cron-tick',
      source: 'cron',
      content: job.task ?? '',
    }

    await events.emit({
      type: event.type,
      source: event.source ?? 'cron',
      content: event.content,
      targetSessionId,
      delivery: event.delivery,
      meta: {
        ...(event.meta ?? {}),
        'cron-id': job.id,
        schedule: job.schedule,
      },
    })
  })
  loadable.set('cron', new CronTool(cronService))
  tools.register(new EventSubscribeTool(events))
  // Clean up event subscriptions linked to one-shot cron jobs when they are
  // auto-removed after firing (prevents orphaned subscriptions in `list`).
  cronService.setOnJobRemoved((jobId) => {
    events.unsubscribeByCronJob(jobId)
  })

  const learning = new LearningService(bus, scope, {
    reflector: signal => {
      signal.throwIfAborted()
      return triggerReflectorFlush(sessions, signal)
    },
    encapsulator: signal => {
      const today = new Date().toISOString().slice(0, 10)
      return sessions.startSession({
        signal,
        channel: 'heartbeat',
        agentType: 'encapsulator',
        task:
          `Encapsulate: read event log at memory/events/${today}.jsonl and referenced wiki items. Encapsulate recurring complexity into a skill, tool/CLI, or dedicated agent.`,
      })
    },
    soulReflector: signal => {
      const today = new Date().toISOString().slice(0, 10)
      return sessions.startSession({
        signal,
        channel: 'heartbeat',
        agentType: 'soul-reflector',
        task:
          `Soul Reflect: read event log at memory/events/${today}.jsonl and identity wiki items under memory/identities/. Refine SOUL.md based on stable interaction patterns.`,
      })
    },
  }, config.learning)
  cleanup.push(() => learning.stop())
  app.get('/api/learning', c => c.json(learning.status()))

  const updateConfig = (newConfig: Config) => {
      const newProvider = createAggregatedProvider(newConfig, copilotAuth)
      const newQuickModel = newConfig.agent.quickModel
      const newLlm = createLlmRuntimeConfig(newConfig)
      learning.update(newConfig.learning)
      sessions.updateProvider(newProvider, newQuickModel)
      provider = newProvider
      llm = newLlm
      activeConfig = newConfig
      channels.updateConfig(newConfig)
  }
  const botStore = new BotInstanceStore({
    organizationId: organization.id,
    path: resolve(workspace, '..', 'config', 'bots.v1.json'),
    ...(organization.id === DEFAULT_ORGANIZATION_ID ? { legacyConfig: config, legacyRawChannels: await configStore.persistedChannels() } : {}),
  })
  const channels: ChannelManager = new ChannelManager(config, bus, sessions, (msg) => agent.receiveChannelMessage(msg), {
    organizationId: organization.id, instanceStore: botStore,
  })
  cleanup.push(() => channels.stopAll())
  await channels.init()
  const projects = new ProjectService({
    registry: projectRegistry,
    remoteExecutor,
    createSession: async (project, requestId) => {
      const chatId = `chat-${requestId ?? randomUUID()}`
      const sessionId = `web:${chatId}`
      const existing = sessions.getSessionState(sessionId)
      if (existing) {
        if (existing.projectId !== project.id) {
          throw new ProjectError('project_request_conflict', 'This request ID belongs to another project.', 409)
        }
        return { sessionId, chatId }
      }
      await sessions.buildSession(sessionId, undefined, {
        projectId: project.id,
        workdir: project.kind === 'remote' ? project.workdir : {
          ...localProjectWorkdirRef(project.id),
          displayName: project.name,
          displayPathSnapshot: project.path,
        },
      })
      return { sessionId, chatId }
    },
  })
  cleanup.push(() => projects.dispose())
  const releaseProjectLifecycle = dependencies.catalog.configureProjectLifecycle(organization.id, {
    assertIdle: () => {
      projects.assertIdle()
      if (sessions.hasProjectWork || backgroundTasks.hasRunningTasks || remoteExecutor.hasPendingJobs ||
        processManager.list().some(process => !process.exitedAt)) {
        throw new ProjectError('project_busy', 'Wait for active conversations, background work and remote jobs in this organization to finish or stop them, then retry.', 409)
      }
    },
    invalidate: () => sessions.invalidateProjectSessions(),
    sessionsToRetire: (project, claims) => sessions.projectDependentSessions(project.id, [
      project.kind === 'remote' ? project.workdir : localProjectWorkdirRef(project.id),
      ...claims.map(claim => claim.workdir),
    ]),
  })
  cleanup.push(releaseProjectLifecycle)

  for (const plugin of [
    otelPlugin(otelStore),
    agentTypesPlugin(sessions, agentTypes),
    sessionsApiPlugin(sessions),
    remoteSessionPlugin({
      sessions,
      authorize: dependencies.authorize,
      requireProjectOwnership: true,
      projects: projectRegistry,
    }),
    projects.plugin,
    botSetupPlugin({
      store: botStore,
      runtime: channels,
      authorize: dependencies.authorize,
    }),
    providerPlugin(() => provider),
    organizationConfigPlugin(configStore),
  ]) plugin(app)

  // ── Channel manager ───────────────────────────────────────────────
  // Each channel registers its own routes (e.g. feishu proxy) onto the app
  await channels.startAll(app)

  // Register subagent tool (requires ChannelManager for thread creation)
  tools.register(
    new SubagentTool(bus, sessions, agentTypes, channels),
  )

  // Register eval bridge routes before starting the server.
  registerEvalBridgeRoute(app, evalBridge)

  // ── Graceful shutdown ─────────────────────────────────────────────
  let shutdownPromise: Promise<void> | undefined
  const shutdown = () => {
    shutdownPromise ??= shutdownRuntime()
    return shutdownPromise
  }
  const shutdownRuntime = async () => {
    channels.beginShutdown()
    const stopLearning = learning.stop()
    console.info('[main] Shutting down...')
    bus.emit('app.lifecycle', { action: 'stop' })
    clearInterval(pulseTimer)
    const errors: unknown[] = []
    // Quiesce producers before draining output; one failed cleanup must not
    // leave the remaining channels, persistence writes, or gateway running.
    for (const close of [
      () => cronService.stop(),
      () => stopLearning,
      () => projects.dispose(),
      () => handoffManager.stop(),
      () => backgroundTasks.stop(),
      () => agent.shutdown(),
      () => skills.stopWatching(),
      () => agentTypes.stopWatching(),
      () => mcpManager.stopWatching(),
      () => channels.stopAll(),
      () => events.stop(),
      () => bus.stopAll(),
      () => chromeManager.releaseAll(),
      () => evalBridge.shutdown(),
      () => sessionStore.close?.(),
      () => closeTelemetry(),
      releaseProjectLifecycle,
    ]) {
      try { await close() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Organization shutdown failed')
  }

  // ── Start everything ──────────────────────────────────────────────
  console.info('[main] Starting all services...')

  const startAgent = agent.start()
  const startCron = cronService.start()
  cleanup.push(() => cronService.stop())
  cleanup.push(() => agent.shutdown())
  cleanup.push(() => backgroundTasks.stop())
  cleanup.push(() => handoffManager.stop())
  cleanup.push(() => learning.stop())
  cleanup.push(() => cronService.stop())

  // Recover sessions interrupted by the previous process exit.
  const ready = Promise.all([startAgent, startCron]).then(async () => {
    await sessions.recoverIncompleteSessions()
  })
  await ready
  console.info('[main] All services started')
  return { app, projects: projectRegistry, ready, shutdown, updateConfig,
    setGatewayBaseUrl: url => evalBridge.setGatewayBaseUrl(url) }
  }
}
