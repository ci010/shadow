import { resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile as nodeWriteFile } from 'node:fs/promises'
import { Hono } from 'hono'
import { AgentTypesManager } from '../../agent/types/manager.ts'
import { AgentApp } from '../../agent/app.ts'
import { BackgroundTaskManager } from '../../agent/background-task.ts'
import { backgroundTasksPlugin } from '../../agent/background-task-routes.ts'
import { ContextBuilder } from '../../agent/context/builder.ts'
import { guidelineProvider } from '../../agent/context/guideline.ts'
import { initiativeProvider } from '../../agent/context/initiative.ts'
import { memoryProvider } from '../../agent/context/memory-provider.ts'
import { projectProvider } from '../../agent/context/project.ts'
import { topicProvider } from '../../agent/context/topic.ts'
import { TopicService } from '../../sessions/topics.ts'
import { topicsPlugin } from '../../sessions/topic-routes.ts'
import { TopicTool } from '../../tools/topic.ts'
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
import { triggerReflectorFlush, learningTask } from '../../agent/learning/pipelines.ts'
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
import { localFolderWorkdirRef, resolveSessionLocations, type WorkdirCapabilityLookup } from '../../sessions/locality.ts'
import { FolderError, FolderRegistry } from '../../folders/registry.ts'
import { FolderService } from '../../folders/routes.ts'
import { ProjectFolderDiscovery } from '../../folders/discovery.ts'
import { folderAccessMiddleware } from '../../folders/access.ts'
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
import { createMcpConfigHandler } from '../../mcp/virtual-config.ts'
import { MemoryLinkCheckHook } from '../../tools/hooks/memory-link-checker.ts'
import { WorkingSetHook } from '../../tools/hooks/working-set.ts'
import { ConventionTool } from '../../tools/convention.ts'
import { MessageTool } from '../../tools/message.ts'
import { PlanWriteTool } from '../../tools/plan-write.ts'
import { ProcessManager } from '../../execution/processes/manager.ts'
import { InitiativeTool } from '../../tools/initiative.ts'
import { InitiativeStore } from '../../initiatives/store.ts'
import { INITIATIVE_SCHEMA_PROMPT } from '../../initiatives/schema.ts'
import { ReadTool } from '../../tools/read.ts'
import { Tools } from '../../tools/registry.ts'
import { ExecTool } from '../../tools/shell.ts'
import { SubagentTool } from '../../tools/subagent.ts'
import { YieldTool } from '../../tools/yield.ts'
import { remoteSessionPlugin } from '../../sessions/remote-session-routes.ts'
import { RemoteFolderOwnership } from '../../folders/remote-ownership.ts'
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
import { projectConfigPlugin } from '../../projects/config-routes.ts'
import { EventService } from '../../events/service.ts'
import { CronService } from '../../cron/service.ts'
import { CronDispatcher } from '../../cron/dispatch.ts'
import { registerAutomationRoutes } from '../../cron/routes.ts'
import { resolveAutomationSession } from '../../cron/contracts.ts'

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
import { sessionDiagnosisPlugin } from '../../sessions/diagnosis-routes.ts'
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
import { isCronEventPayload } from '../../cron/events.ts'
import type { ProjectRuntime, ProjectRuntimeDependencies } from '../../projects/runtime.ts'
import { assertSessionProjectOwnership } from '../../projects/session-ownership.ts'
import { EvalBridgeRuntime } from '../../script-runtime/bridge.ts'
import { DEFAULT_PROJECT_ID } from '../../projects/contracts.ts'
import { ProjectExecutor } from '../../projects/executor.ts'
import { LearningService } from '../../agent/learning/service.ts'
import { RealtimeHub, registerRealtimeRoute } from '../../realtime/hub.ts'
import { IoBroker } from '../../io/broker.ts'
import { IO_TERMINAL, IoError } from '../../io/contracts.ts'
import { registerIoRoutes } from '../../io/routes.ts'
import { IoCapabilitiesTool, IoRunTool } from '../../tools/io.ts'
import { IoSurfaceTool } from '../../tools/io-surface.ts'
import { createPromptCaptureStore } from '../../sessions/prompt-capture.ts'

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

export async function createProjectRuntime(
  config: Config,
  dependencies: ProjectRuntimeDependencies,
): Promise<ProjectRuntime> {
  const { scope, project, mainCluster, copilotAuth, configStore } = dependencies
  const workspace = config.agent.workspace
  const selfCodeRoot = dependencies.selfCodeRoot
  const cleanup: Array<() => unknown> = []
  const promptCaptures = createPromptCaptureStore(project.id)
  if (promptCaptures) cleanup.push(() => promptCaptures.clear())

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
  const realtimeHub = dependencies.realtimeHub ?? new RealtimeHub()
  const realtime = realtimeHub.registerProject(project.id, {
    latest: kind => kind === 'spans' ? otelStore.getLatestSpanId() : otelStore.getLatestLogId(),
    query: (kind, afterId, limit) => (kind === 'spans'
      ? otelStore.querySpans({ afterId, limit, ascending: true })
      : otelStore.queryLogs({ afterId, limit, ascending: true }))
      .filter((row): row is { id: number } => typeof row === 'object' && row !== null && 'id' in row && Number.isSafeInteger(row.id)),
  })
  const closeRealtime = () => {
    realtime.close()
    if (!dependencies.realtimeHub) realtimeHub.close()
  }
  cleanup.push(closeRealtime)
  for (const topic of ['session.input.accepted', 'session.message.appended', 'session.turn.finished', 'session.handoff', 'session.ended', 'background.task.changed'] as const) {
    const subscription = bus.on(topic, fact => realtime.invalidateSessions(fact.sessionId))
    cleanup.push(() => bus.off(subscription))
  }
  const telemetry = initializeNodeTelemetry(otelStore, { scope, projectId: project.id })
  let telemetryShutdown: Promise<void> | undefined
  const closeTelemetry = () => {
    telemetryShutdown ??= telemetry.shutdown().finally(() => otelStore.close())
    return telemetryShutdown
  }
  console.info(`[main] OTel store: ${otelDbPath}`)
  console.info(`[project:${project.id}] Starting: workspace=${workspace}, model=${config.agent.model}`)

  cleanup.push(closeTelemetry)
  try {
    await events.start()
    return await startServices()
  } catch (error) {
    for (const close of cleanup.reverse()) {
      try { await close() } catch (cleanupError) { console.error('[project] Startup cleanup failed', cleanupError) }
    }
    throw error
  }

  async function startServices(): Promise<ProjectRuntime> {
  // ── Build tool registry ─────────────────────────────────────────────
  const vfs = new VirtualFs()
  const tools = new Tools(workspace)
  tools.register(new ReadTool(workspace, vfs))
  tools.register(
    new WriteTool(
      workspace,
      selfCodeRoot,
      config.tools.restrictToWorkspace,
      vfs,
    ),
  )
  tools.register(new PlanWriteTool(workspace))

  // ── Execution hooks ───────────────────────────────────────────────
  tools.addHook(new MemoryLinkCheckHook(workspace))

  const identity = new IdentityManager(workspace, project.id)

  // ── Create gateway app early so we can pass it to Agent ──
  const app = new Hono()
  app.use('*', (_c, next) => scope.run(next))
  if (!dependencies.realtimeHub) registerRealtimeRoute(app, realtimeHub, dependencies.authorize)
  const evalBridge = new EvalBridgeRuntime({ projectId: project.id, scope, gatewayBaseUrl: dependencies.gatewayBaseUrl })
  cleanup.push(() => evalBridge.shutdown())
  const folderRegistry = new FolderRegistry(resolve(workspace), { projectId: project.id, catalog: dependencies.catalog })
  await folderRegistry.init()
  app.use('*', folderAccessMiddleware(folderRegistry))
  const ownsWorkdir = (ref: import('../../sessions/locality.ts').WorkdirRefV1): boolean => {
    if (folderRegistry.lookupWorkdir(ref)?.capability) return true
    if (folderRegistry.ownsRemoteWorkdir(ref)) return true
    if (folderRegistry.isRetiredWorkdir(ref)) return false
    return sessions.listSessions().some(session => {
      const workdir = sessions.getSessionState(session.sessionId)?.workdir
      return workdir?.nodeId === ref.nodeId && workdir.capabilityId === ref.capabilityId
    })
  }
  const workdirCapabilityLookup: WorkdirCapabilityLookup = ref =>
    folderRegistry.lookupWorkdir(ref) ?? (ownsWorkdir(ref) ? mainCluster.workdirCapabilityLookup(ref) : { node: 'online' })
  const remoteExecutor = new ProjectExecutor(project.id, mainCluster.remoteExecutor, request => {
    if (request.sessionId === `folder-identity:${project.id}` && request.operation === 'workdir.identity') return
    if (request.sessionId.startsWith('folder:')) {
      if (!folderRegistry.get(request.sessionId.slice('folder:'.length))) {
        throw new FolderError('folder_access_revoked', 'This folder is no longer available to this project.', 409)
      }
    } else {
      sessions.assertFolderAccess(request.sessionId)
    }
    if (!ownsWorkdir({ version: 1, nodeId: request.nodeId, capabilityId: request.capabilityId })) {
      throw new FolderError('folder_access_revoked', 'This folder is no longer available to this project.', 409)
    }
  }, (jobId, pending) => dependencies.catalog.recordRemoteJob(project.id, jobId, pending))
  folderRegistry.configureRemote(new RemoteFolderOwnership({
    projectId: project.id,
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
    projectId: project.id, portAllocator: dependencies.chromePortAllocator,
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

  const initiativeTool = new InitiativeTool({
    query: (sql, actor, signal) => initiatives.query(sql, actor, signal),
  }, project.id, INITIATIVE_SCHEMA_PROMPT)
  loadable.set('initiative', initiativeTool)
  tools.register(initiativeTool)
  const skills = new SkillsManager(workspace)
  const importTool = new ImportTool(loadable, workspace, chromeManager, name => skills.getSkillDirectory(name))
  tools.register(new SearchTool(workspace, webSearchTool, vfs, importTool, skills, () => topics))
  tools.register(new InvokeTool(importTool))

  tools.register(new BackgroundTaskTool(backgroundTasks))
  tools.register(new ContinuationTool(backgroundTasks))
  tools.register(new LogTool(workspace))

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
  tools.register(new ConventionTool(memory,
    id => sessions.getSessionState(id)?.initiativeId,
    id => sessions.assertInitiativeAccess(id)))
  const agentTypes = new AgentTypesManager(workspace)
  cleanup.push(() => skills.stopWatching())
  cleanup.push(() => agentTypes.stopWatching())
  const sessionsDir = workspacePath(workspace, '.sessions')
  const sessionStore: SessionStore = config.agent.sessionStorage === 'sqlite'
    ? new SqliteSessionStore(sessionsDir)
    : new JsonlSessionStore(sessionsDir)

  await sessionStore.init()
  cleanup.push(() => sessionStore.close?.())
  await assertSessionProjectOwnership(sessionStore, project.id)

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
    projectId: project.id,
    promptCaptures,
    hasInitiative: id => initiatives.getSummary(id) !== null,
    scope,
    ownsFolder: id => !!folderRegistry.get(id),
    ownsWorkdir,
    assertSessionFolder: state => folderRegistry.assertSessionFolder(state),
    acquireFolderAccess: () => folderRegistry.acquireAccess(),
    evalBridge,
    workspace,
    store: sessionStore,
    handoffManager,
    bus,
    provider,
    tools,
    toolLoader: importTool,
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
  const ioLocations = (sessionId: string) => {
    const state = sessions.getSessionState(sessionId)
    if (!state) throw new IoError('session_not_found', 'The owning conversation no longer exists', 404)
    sessions.assertFolderAccess(sessionId)
    const locations = resolveSessionLocations(workspace, state, undefined, sessions.workdirCapabilityLookup)
    if (!locations.workdir.available || locations.workdir.locality === 'remote') {
      throw new IoError('local_io_only', 'Browser I/O currently requires a local conversation', 409)
    }
    return locations
  }
  const ioTasks = new Map<string, ReturnType<BackgroundTaskManager['createDeferredTask']>>()
  const io = new IoBroker({
    projectId: project.id, workspace,
    assertSession: sessionId => { ioLocations(sessionId) },
    sessionDirectory: sessionId => ioLocations(sessionId).sessionDataDir,
    changed: run => {
      realtime.invalidateIo?.(run.id)
      if (!ioTasks.has(run.id) && run.status === 'awaiting_consent') {
        ioTasks.set(run.id, backgroundTasks.createDeferredTask({
          kind: 'tool', title: `I/O: ${run.definition.title}`, sessionId: run.sessionId,
          tags: { ioRunId: run.id },
          callback: { sessionId: run.sessionId, eventType: 'io-run-complete' },
          observe: () => JSON.stringify({ id: run.id, status: io.get(run.id).status }),
          onCancel: () => { void io.stop(run.id, 'cancelled', 'Background task cancelled').catch(error => console.error('[io] Cancellation failed', error)) },
        }))
      }
      if (IO_TERMINAL.has(run.status)) {
        const task = ioTasks.get(run.id)
        if (run.status === 'completed') task?.complete(JSON.stringify({
          id: run.id, status: run.status,
          artifacts: run.artifacts.map(({ id, name, mime, size, complete }) => ({ id, name, mime, size, complete })),
        }))
        else task?.fail(run.error ?? `I/O ${run.status}`)
        ioTasks.delete(run.id)
      }
    },
  })
  await io.start()
  cleanup.push(() => io.shutdown())
  registerIoRoutes(app, io, dependencies.authorize)
  importTool.registerBuiltin('io_capabilities', new IoCapabilitiesTool(io, project.id))
  importTool.registerBuiltin('io_run', new IoRunTool(io, project.id))
  importTool.registerBuiltin('io_surface', new IoSurfaceTool(io, project.id))

  const initiatives = new InitiativeStore(workspace, {
    isSessionKnown: id => sessions.getSessionState(id) !== null,
    isSessionActive: id => {
      if (sessions.getSessionState(id)?.recovery) return false
      const active = sessions.getActiveSession(id)
      if (active) return active.accepting
      return false
    },
  })
  cleanup.push(() => initiatives.close())
  initiatives.migrateLegacyMarkdown()
  const topics = new TopicService({
    projectId: project.id,
    sessions,
    folders: folderRegistry,
    listStates: async () => (await sessions.listSessions())
      .flatMap(entry => { const state = sessions.getSessionState(entry.sessionId); return state ? [state] : [] }),
    firstMessage: id => sessions.getFirstUserMessage(id),
    resolveAgent: name => agentTypes.resolve(name),
    changed: id => realtime.invalidateSessions(id),
  })
  tools.register(new TopicTool(topics))

  context.register(guidelineProvider())
  context.register(
    workspaceProvider(workspace, vfs, workdirCapabilityLookup),
  )
  context.register(runtimeIdentityProvider({
    projectId: project.id,
    identity,
    getProjectNodeInventory: id => id === project.id ? sessions.getNodeInventory() : undefined,
    getSkillsSummary: (admin) => skills.getMetadataSummary(admin) || '',
    getAgentTypesSummary: () => agentTypes.getAgentTypesSummary(),
    getChannelCapabilities: (channel, chatId, address) => channels.getCapabilities(channel, chatId, address),
    isTrustedConversation: (channel, chatId, address) => channels.isTrustedConversation(channel, chatId, address),
    getActiveSubagents: (parentSessionId) =>
      sessions.getChildren(parentSessionId) ?? Promise.resolve([]),
  }))
  const projectFolderDiscovery = new ProjectFolderDiscovery({
    projectId: project.id,
    workspace,
    getProject: () => dependencies.catalog.get(project.id),
    registry: folderRegistry,
    workdirCapabilityLookup,
  })
  context.register(projectProvider(projectFolderDiscovery))
  context.register(topicProvider(id => sessions.getSessionState(id)))
  context.register(initiativeProvider(initiatives))
  context.register(memoryProvider(
    memory,
    (sid) => sessions.getSessionState(sid)?.initiativeId ?? undefined,
  ))

  const mcpManager = new McpManager(
    servers => importTool.updateMcpServers(servers), config.mcp.servers,
  )
  cleanup.push(() => mcpManager.stop())

  // ── Virtual filesystem mounts ─────────────────────────────────────────

  const projectFoldersVfs = projectFolderDiscovery.handlers()
  vfs.mount(
    'v:project',
    'read-only current project folder discovery; read v:project/folders for live metadata and availability, not cwd or access grants',
    projectFoldersVfs.read,
    projectFoldersVfs.list,
  )

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

  const skillsVfs = createSkillsHandler(skills, (skill, context) => importTool.registerSkillTools(skill, context))
  vfs.mount(
    'v:skills',
    'read skill bodies and category listings',
    skillsVfs.read,
  )

  const mcpConfigVfs = createMcpConfigHandler({
    projectId: project.id,
    configStore,
    isReservedName: name => name === 'import_tool' || name === 'install_tool' || importTool.isBuiltinName(name) || tools.has(name),
  })
  vfs.mount('v:config', 'Project MCP configuration: mcp.json', mcpConfigVfs.read, undefined, mcpConfigVfs.write)

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
      (initiativeId, itemId) => initiatives.assertWorkReference(initiativeId, itemId),
    ),
  )
  tools.register(new YieldTool(sessions.yields))

  // ── Cron service ──────────────────────────────────────────────────
  const cronService = new CronService(workspace, config.cron.timezone)
  const cronDispatcher = new CronDispatcher(sessions, async (job, targetSessionId, signal) => {
    signal.throwIfAborted()
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
  }, sessionId => realtime.invalidateSessions(sessionId))
  cronService.setHandler(async (job, signal) => { await cronDispatcher.dispatch(job, signal) })
  cronService.setOnChanged(() => realtime.invalidateSessions())
  registerAutomationRoutes(app, cronService, sessions, project.id)
  importTool.registerBuiltin('cron', new CronTool(cronService, sessions, name => !!agentTypes.resolve(name)))
  tools.register(new EventSubscribeTool(events))
  // Clean up event subscriptions linked to one-shot cron jobs when they are
  // auto-removed after firing (prevents orphaned subscriptions in `list`).
  cronService.setOnJobRemoved((jobId) => {
    events.unsubscribeByCronJob(jobId)
  })

  const learning = new LearningService(bus, scope, {
    reflector: async (signal, job, accepted) => {
      signal.throwIfAborted()
      let sessionId: string | undefined
      const ran = await triggerReflectorFlush(sessions, signal, async task => {
        sessionId = await cronDispatcher.dispatch(job, signal, task, accepted)
        return sessionId
      })
      return ran ? sessionId : false
    },
    encapsulator: (signal, job, accepted) => cronDispatcher.dispatch(job, signal, learningTask('encapsulator'), accepted),
    soulReflector: (signal, job, accepted) => cronDispatcher.dispatch(job, signal, learningTask('soulReflector'), accepted),
  }, config.learning, cronService, sessionId => {
    const state = sessions.getSessionState(sessionId)
    return !!state && resolveAutomationSession(state)?.config?.source === 'learning'
  })
  commandDispatcher.register(createLearnCommand(sessions, pipeline => learning.trigger(pipeline)))
  cleanup.push(() => learning.stop())
  app.get('/api/learning', c => c.json(learning.status()))

  const updateConfig = async (newConfig: Config) => {
      const newProvider = createAggregatedProvider(newConfig, copilotAuth)
      const newQuickModel = newConfig.agent.quickModel
      const newLlm = createLlmRuntimeConfig(newConfig)
      try {
        await mcpManager.load(newConfig.mcp.servers)
      } catch (cause) {
        try {
          await mcpManager.load(activeConfig.mcp.servers)
        } catch (rollback) { throw new AggregateError([cause, rollback], 'Tool catalog update and rollback failed') }
        throw cause
      }
      learning.update(newConfig.learning)
      sessions.updateProvider(newProvider, newQuickModel)
      provider = newProvider
      llm = newLlm
      activeConfig = newConfig
      channels.updateConfig(newConfig)
  }
  const botStore = new BotInstanceStore({
    projectId: project.id,
    path: resolve(workspace, '..', 'config', 'bots.v1.json'),
    ...(project.id === DEFAULT_PROJECT_ID ? { legacyConfig: config, legacyRawChannels: await configStore.persistedChannels() } : {}),
  })
  const channels: ChannelManager = new ChannelManager(config, bus, sessions, (msg) => agent.receiveChannelMessage(msg), {
    projectId: project.id, instanceStore: botStore, realtime,
  })
  cleanup.push(() => channels.stopAll())
  await channels.init()
  const folders = new FolderService({
    registry: folderRegistry,
    remoteExecutor,
    createSession: async (folder, requestId) => {
      const chatId = `chat-${requestId ?? randomUUID()}`
      const sessionId = `web:${chatId}`
      const existing = sessions.getSessionState(sessionId)
      if (existing) {
        if (existing.folderId !== folder.id) {
          throw new FolderError('folder_request_conflict', 'This request ID belongs to another folder.', 409)
        }
        return { sessionId, chatId }
      }
      await sessions.buildSession(sessionId, undefined, {
        folderId: folder.id,
        workdir: folder.kind === 'remote' ? folder.workdir : {
          ...localFolderWorkdirRef(folder.id),
          displayName: folder.name,
          displayPathSnapshot: folder.path,
        },
      })
      return { sessionId, chatId }
    },
  })
  cleanup.push(() => folders.dispose())
  const releaseFolderLifecycle = dependencies.catalog.configureFolderLifecycle(project.id, {
    assertIdle: () => {
      folders.assertIdle()
      if (sessions.hasFolderWork || backgroundTasks.hasRunningTasks || remoteExecutor.hasPendingJobs ||
        processManager.list().some(process => !process.exitedAt)) {
        throw new FolderError('folder_busy', 'Wait for active conversations, background work and remote jobs in this project to finish or stop them, then retry.', 409)
      }
    },
    invalidate: () => sessions.invalidateFolderSessions(),
    sessionsToRetire: (folder, claims) => sessions.folderDependentSessions(folder.id, [
      folder.kind === 'remote' ? folder.workdir : localFolderWorkdirRef(folder.id),
      ...claims.map(claim => claim.workdir),
    ]),
  })
  cleanup.push(releaseFolderLifecycle)

  for (const plugin of [
    otelPlugin(otelStore),
    agentTypesPlugin(sessions, agentTypes),
    sessionDiagnosisPlugin({
      projectId: project.id,
      getState: id => sessions.getSessionState(id),
      readRecords: id => sessionStore.readSessionLog(id),
      querySpans: query => otelStore.querySessionSpans(query),
      captures: id => sessions.getPromptCaptures(id),
    }, {
      authorize: dependencies.authorize,
      assertAccess: id => sessions.assertFolderAccess(id),
    }),
    sessionsApiPlugin(sessions, { authorizeContext: dependencies.authorize }),
    topicsPlugin(topics, dependencies.authorize),
    backgroundTasksPlugin(backgroundTasks, id => !!sessions.getSessionState(id)),
    remoteSessionPlugin({
      sessions,
      authorize: dependencies.authorize,
      requireFolderOwnership: true,
      folders: folderRegistry,
    }),
    folders.plugin,
    botSetupPlugin({
      store: botStore,
      runtime: channels,
      authorize: dependencies.authorize,
    }),
    providerPlugin(() => provider),
    projectConfigPlugin(configStore),
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
    closeRealtime()
    channels.beginShutdown()
    const stopLearning = learning.stop()
    console.info('[main] Shutting down...')
    bus.emit('app.lifecycle', { action: 'stop' })
    clearInterval(pulseTimer)
    const errors: unknown[] = []
    // Quiesce producers before draining output; one failed cleanup must not
    // leave the remaining channels, persistence writes, or gateway running.
    for (const close of [
      () => io.shutdown(),
      () => cronService.stop(),
      () => stopLearning,
      () => folders.dispose(),
      () => handoffManager.stop(),
      () => backgroundTasks.stop(),
      () => agent.shutdown(),
      () => skills.stopWatching(),
      () => agentTypes.stopWatching(),
      () => mcpManager.stop(),
      () => channels.stopAll(),
      () => events.stop(),
      () => bus.stopAll(),
      () => chromeManager.releaseAll(),
      () => evalBridge.shutdown(),
      () => initiatives.close(),
      () => sessionStore.close?.(),
      () => closeTelemetry(),
      releaseFolderLifecycle,
    ]) {
      try { await close() } catch (error) { errors.push(error) }
    }
    if (errors.length) throw new AggregateError(errors, 'Project shutdown failed')
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
  return { app, folders: folderRegistry, ready, shutdown, updateConfig,
    setGatewayBaseUrl: url => evalBridge.setGatewayBaseUrl(url) }
  }
}
