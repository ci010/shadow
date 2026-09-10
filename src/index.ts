import { resolve } from 'node:path'
import { readFile, stat as nodeStat, writeFile as nodeWriteFile } from 'node:fs/promises'
import process from 'node:process'
import { env } from 'node:process'
import { getOs } from './utils/runtime.ts'
import { Hono } from 'hono'
import { AgentTypesManager } from './agent/agent-types/manager.ts'
import { AgentApp } from './agent/agent.ts'
import { BackgroundTaskManager } from './agent/background-task.ts'
import { ContextBuilder } from './agent/context/builder.ts'
import { guidelineProvider } from './agent/context/guideline.ts'
import { projectProvider } from './agent/context/project.ts'
import { memoryProvider } from './agent/context/memory-provider.ts'
import { runtimeIdentityProvider } from './agent/context/runtime.ts'
import { workspaceProvider } from './agent/context/workspace.ts'
import { IdentityManager } from './agent/identity.ts'
import type { LlmRuntimeConfig } from './agent/llm-config.ts'
import { MemoryStore } from './agent/memory.ts'
import { sessionPlugin } from './agent/routes.ts'
import { createConfigCommand } from './commands/handlers/config.ts'
import { createDumpPromptCommand } from './commands/handlers/dump-prompt.ts'
import { createHelpCommand } from './commands/handlers/help.ts'
import {
  createLearnCommand,
  triggerReflectorFlush,
} from './commands/handlers/learn.ts'
import { createCompactCommand } from './commands/handlers/compact.ts'
import { createSessionsCommand } from './commands/handlers/sessions.ts'
import { createStatusCommand } from './commands/handlers/status.ts'
import { CommandDispatcher } from './commands/index.ts'
import type { Config, McpServerConfig } from './config/schema.ts'
import { HandoffManager } from './handoff/manager.ts'
import { McpManager } from './mcp/manager.ts'
import { SessionManager } from './sessions/session-manager.ts'
import { JsonlSessionStore } from './sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from './sessions/session-store-sqlite.ts'
import { SkillsManager } from './skills/loader.ts'
import { BackgroundTaskTool, ContinuationTool } from './tools/background.ts'
import { CommandHandlerManager } from './tools/commands/command-handler.ts'
import { createUserLinkCommandHandler } from './tools/commands/userlink.ts'
import { CronTool } from './tools/cron.ts'
import { LogTool } from './tools/log.ts'
import { EventSubscribeTool } from './tools/event-subscribe.ts'
import { WriteTool } from './tools/filesystem.ts'
import type { LoadableEntry, McpLoadable } from './tools/load-tool.ts'
import { InvokeTool } from './tools/invoke-tool.ts'
import { ImportTool } from './tools/load-tool.ts'
import { MemoryLinkCheckHook } from './hooks/memory-link-checker.ts'
import { WorkingSetHook } from './hooks/working-set.ts'
import { ConventionTool } from './tools/convention.ts'
import { MessageTool } from './tools/message.ts'
import { PlanWriteTool } from './tools/plan-write.ts'
import { ProcessManager } from './agent/process-manager.ts'
import { ProjectTool } from './tools/project.ts'
import { ReadTool } from './tools/read.ts'
import { Tools } from './tools/registry.ts'
import { ExecTool } from './tools/shell.ts'
import { SubagentTool } from './tools/subagent.ts'
import {
  createBgTasksHandler,
  createEventsHandler,
  createMemoryHandler,
  createSessionsHandler,
  createSkillsHandler,
} from './vfs/mounts.ts'
import { VirtualFs } from './vfs/virtual-fs.ts'

import { Bus } from './bus/bus.ts'
import { ChannelManager } from './channels/manager.ts'
import { loadConfig } from './config/loader.ts'
import { configPlugin } from './config/routes.ts'
import { EventService } from './events/service.ts'
import { CronService } from './cron/service.ts'

import {
  GatewayClientAddressRegistry,
  registerGatewayRoutes,
  resolveLaunchCredential,
  serveGateway,
  validateLaunchCredential,
} from './gateway/server.ts'
import { devProxyPlugin } from './gateway/dev-proxy.ts'
import { uiPlugin } from './gateway/ui.ts'
import { OtelStore } from './otel/store.ts'
import { initializeNodeTelemetry } from './otel/runtime.ts'
import { otelPlugin } from './otel/routes.ts'
import {
  createAggregatedProvider,
  detectProvider,
} from './providers/factory.ts'
import { parseModelSpec } from './providers/aggregated.ts'
import { resolveContextWindow } from './providers/model-registry.ts'
import { providerPlugin } from './providers/routes.ts'
import { sessionsApiPlugin } from './sessions/routes.ts'
import { registerEvalBridgeRoute } from './eval/bridge.ts'
import { SearchTool } from './tools/search.ts'
import {
  detectSearXNG,
  FirecrawlSearchTool,
  SearXNGSearchTool,
  WebSearchTool,
} from './tools/web.ts'
import { ChromeManager } from './utils/chrome-manager.ts'
import { cleanupTempFiles, workspacePath } from './utils/paths.ts'
import { isCronEventPayload, isCronEventTarget } from './cron/events.ts'
import {
  attachBackendSignalHandlers,
  type BackendProcessHooks,
  parseBackendCliArguments,
} from './runtime/backend-cli.ts'
import { LocalRuntimeControl } from './runtime/local-control.ts'
import {
  type ProcessEntryResult,
  runProcessEntry,
} from './runtime/process-entry.ts'
import {
  createMainCluster,
  MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
} from './cluster/main-cluster.ts'
import { AtomicFileRegistrySnapshotAdapter } from './cluster/persistence.ts'
import { startProductionChildRuntime } from './runtime/production-child.ts'

export interface MainRuntimeHandle {
  readonly ready: Promise<void>
  readonly finished: Promise<void>
  shutdown(): Promise<void>
}

export interface MainRuntimeOptions {
  readonly configPath?: string
  readonly clusterSnapshotPath?: string
  readonly gateway?: {
    readonly port?: number
    readonly host?: string
    readonly launchCredential?: string
  }
}

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

async function resolveSelfCodeRoot(workspace: string): Promise<string> {
  const candidates = [
    resolve(workspace, 'src'),
    resolve(workspace, '..', 'src'),
  ]

  for (const candidate of candidates) {
    try {
      const stat = await nodeStat(candidate)
      if (stat.isDirectory()) return candidate
    } catch {
      // Ignore missing candidates.
    }
  }

  return candidates[1]
}

export async function startMainRuntime(
  config: Config,
  options: MainRuntimeOptions = {},
): Promise<MainRuntimeHandle> {
  const configPath = options.configPath
  const workspace = config.agent.workspace
  const selfCodeRoot = await resolveSelfCodeRoot(workspace)

  console.info(
    `[main] Starting bot: workspace=${workspace}, model=${config.agent.model}`,
  )

  // ── Create core components ────────────────────────────────
  const bus = new Bus()
  const events = new EventService(workspace, bus)
  await events.start()
  const provider = createAggregatedProvider(config)
  const backgroundTasks = new BackgroundTaskManager(bus, events)

  // OTel ingest/query store (formerly the standalone observer in app/)
  const otelDbPath = env.OTEL_DB_PATH ??
    workspacePath(workspace, '.otel.db')
  const otelStore = new OtelStore(otelDbPath)
  const telemetry = initializeNodeTelemetry(otelStore)
  let telemetryShutdown: Promise<void> | undefined
  const closeTelemetry = () => {
    telemetryShutdown ??= telemetry.shutdown().finally(() => otelStore.close())
    return telemetryShutdown
  }
  console.info(`[main] OTel store: ${otelDbPath}`)

  try {
    return await startServices()
  } catch (error) {
    await closeTelemetry()
    throw error
  }

  async function startServices(): Promise<MainRuntimeHandle> {
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

  const identity = new IdentityManager(workspace)

  // ── Create gateway app early so we can pass it to Agent ──
  const app = new Hono()
  const clientAddresses = new GatewayClientAddressRegistry()
  const launchCredential = resolveLaunchCredential(
    options.gateway?.launchCredential,
    env.GATEWAY_LAUNCH_CREDENTIAL,
    env.WINDOWS_USE_LAUNCH_TOKEN,
  )
  const mainCluster = await createMainCluster({
    snapshotAdapter: new AtomicFileRegistrySnapshotAdapter(
      options.clusterSnapshotPath ??
        resolve(workspace, '.cluster', 'registry.v1.json'),
    ),
    localHello: {
      protocolMajor: 1,
      protocolMinor: 0,
      implementationVersion: '0.1.0',
      features: ['jobs-v1', 'capabilities-v1'],
    },
    authorizeOfferCreation: (request) =>
      launchCredential
        ? validateLaunchCredential(
          request.headers.get('Authorization') ?? undefined,
          launchCredential,
        )
        : false,
    clientKey: (request) => clientAddresses.resolve(request),
  })

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
  let webSearchTool: import('./tools/tool.ts').Tool | undefined
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

  // Unified search tool �?delegates to glob, grep, and web search
  tools.register(new SearchTool(workspace, webSearchTool, vfs))

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
  let cachedChromeConfig = config.tools.chrome ?? { basePort: 9222 }
  let chromeConfigMtime = 0
  const chromeConfigGetter = (): {
    executablePath?: string
    basePort: number
  } => {
    // Async re-read on next allocate() isn't possible from a sync getter,
    // so we fire-and-forget a background refresh keyed on config file mtime.
    const cfgPath = configPath
    if (cfgPath) {
      nodeStat(cfgPath).then(async (stat) => {
        const mtime = stat.mtime?.getTime() ?? 0
        if (mtime > chromeConfigMtime) {
          chromeConfigMtime = mtime
          try {
            const fresh = await loadConfig(cfgPath)
            cachedChromeConfig = fresh.tools.chrome ?? { basePort: 9222 }
          } catch { /* keep previous */ }
        }
      }).catch(() => {})
    }
    return cachedChromeConfig
  }
  const chromeManager = new ChromeManager(workspace, chromeConfigGetter)
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

  // Register config MCP servers as lazy-loadable entries
  for (const server of config.mcp.servers ?? []) {
    loadable.set(server.name, {
      config: server,
    })
  }

  const importTool = new ImportTool(loadable, workspace, chromeManager)
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
  bus.emit('app.lifecycle', { action: 'start' })

  // ── Create agent services ───────────────────────────────────────────
  const primaryProvider = resolvePrimaryProviderName(config.agent.model)
  const quickModel = config.providers[primaryProvider]?.quickModel ??
    config.agent.quickModel
  let llm = createLlmRuntimeConfig(config)

  const memory = new MemoryStore(workspace)
  tools.addHook(new WorkingSetHook(memory))
  tools.register(new ConventionTool(memory))
  const skills = new SkillsManager(workspace)
  const agentTypes = new AgentTypesManager(workspace)
  const sessionsDir = workspacePath(workspace, '.sessions')
  const sessionStore = config.agent.sessionStorage === 'sqlite'
    ? new SqliteSessionStore(sessionsDir)
    : new JsonlSessionStore(sessionsDir)

  await sessionStore.init()

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

  const context = new ContextBuilder(workspace)
  const sessions = new SessionManager({
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
    workdirCapabilityLookup: mainCluster.workdirCapabilityLookup,
    remoteExecutor: mainCluster.remoteExecutor,
    onSessionStopped: (id) => backgroundTasks.handleSessionStopped(id),
  })

  context.register(guidelineProvider())
  context.register(
    workspaceProvider(workspace, vfs, mainCluster.workdirCapabilityLookup),
  )
  context.register(runtimeIdentityProvider({
    identity,
    getSkillsSummary: (admin) => skills.getMetadataSummary(admin) || '',
    getAgentTypesSummary: () => agentTypes.getAgentTypesSummary(),
    getActiveSubagents: (parentSessionId) =>
      sessions.getChildren(parentSessionId) ?? Promise.resolve([]),
  }))
  context.register(projectProvider(workspace))
  context.register(memoryProvider(
    memory,
    (sid) => sessions.getSessionState(sid)?.projectName ?? undefined,
  ))

  const mcpManager = new McpManager(tools, [], workspace)

  // ── Virtual filesystem mounts ─────────────────────────────────────────

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
    bus,
    sessions,
    skills,
    mcpManager,
    commandDispatcher,
    agentTypes,
    getLlmRuntimeConfig: () => llm,
  })

  commandDispatcher.register(createHelpCommand(commandDispatcher))
  commandDispatcher.register(createConfigCommand(sessions))
  commandDispatcher.register(createCompactCommand(sessions))
  commandDispatcher.register(createDumpPromptCommand(agent))
  commandDispatcher.register(createStatusCommand(sessions))
  commandDispatcher.register(createSessionsCommand(agent))
  commandDispatcher.register(createLearnCommand(sessions))

  tools.register(
    new MessageTool(
      bus,
      (id) => sessions.isEphemeralSession(id),
      (id) => sessions.getSessionState(id)?.parent,
      (parentId) => sessions.getSessionState(parentId)?.children,
    ),
  )

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

    events.emit({
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

  // ── Learning pipelines ──────────────────────────────────────────────
  // All pipelines use bus.poll: buffer events over an interval, aggregate in handler.

  // Reflector: poll message.inbound, aggregate unique session keys (O(1) memory)
  bus.poll<'message.inbound', Set<string>>(
    'message.inbound',
    {
      intervalMs: config.learning.reflectIntervalMs,
      init: () => new Set<string>(),
      reduce: (acc, e) => {
        if (e.channel !== 'sleep' && e.channel !== 'heartbeat') {
          acc.add(`${e.channel}:${e.chatId}`)
        }
        return acc
      },
    },
    (sessionKeys) => {
      if (sessionKeys.size === 0) return
      // The aggregated keys just signal "activity happened"; the watermark diff
      // determines exactly which sessions' increments to flush (dedup).
      void triggerReflectorFlush(sessions)
    },
  )

  // Encapsulator: poll reflector completions, drain every encapsulateIntervalMs
  bus.poll(
    'session.ended',
    { intervalMs: config.learning.encapsulateIntervalMs },
    (events) => {
      if (!events.some((e) => e.agentType === 'reflector')) return
      const today = new Date().toISOString().slice(0, 10)
      sessions.startSession({
        channel: 'heartbeat',
        agentType: 'encapsulator',
        task:
          `Encapsulate: read event log at memory/events/${today}.jsonl and referenced wiki items. Encapsulate recurring complexity into a skill, tool/CLI, or dedicated agent.`,
      })
    },
  )

  // Soul-reflector: poll reflector completions, drain every soulIntervalMs
  bus.poll(
    'session.ended',
    { intervalMs: config.learning.soulIntervalMs },
    (events) => {
      if (!events.some((e) => e.agentType === 'reflector')) return
      const today = new Date().toISOString().slice(0, 10)
      sessions.startSession({
        channel: 'heartbeat',
        agentType: 'soul-reflector',
        task:
          `Soul Reflect: read event log at memory/events/${today}.jsonl and identity wiki items under memory/identities/. Refine SOUL.md based on stable interaction patterns.`,
      })
    },
  )

  console.info(
    `[learning] Pipelines started (reflect: ${config.learning.reflectIntervalMs}ms, encapsulate: ${config.learning.encapsulateIntervalMs}ms, soul: ${config.learning.soulIntervalMs}ms)`,
  )

  let shutdown: () => Promise<void>
  const localControl = new LocalRuntimeControl('main', () => shutdown())

  registerGatewayRoutes(app, [
    ...mainCluster.plugins,
    localControl.plugin(),
    otelPlugin(otelStore),
    sessionPlugin(sessions, agent, agentTypes),
    sessionsApiPlugin(sessions),
    providerPlugin(provider),
    configPlugin({
      configPath,
      onChanged: (newConfig) => {
        try {
          const newProvider = createAggregatedProvider(newConfig)
          const newPrimaryProvider = resolvePrimaryProviderName(
            newConfig.agent.model,
          )
          const newQuickModel =
            newConfig.providers[newPrimaryProvider]?.quickModel ??
              newConfig.agent.quickModel
          llm = createLlmRuntimeConfig(newConfig)
          sessions.updateProvider(newProvider, newQuickModel)
          console.info(
            `[main] Config hot-reloaded: model=${newConfig.agent.model}`,
          )
        } catch (err) {
          console.error('[main] Failed to hot-reload config:', err)
        }
      },
    }),
  ], {
    launchCredential,
    launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  })

  // ── Channel manager ───────────────────────────────────────────────
  const channels = new ChannelManager(config, bus, sessions)
  await channels.init()
  // Each channel registers its own routes (e.g. feishu proxy) onto the app
  await channels.startAll(app)

  // Register subagent tool (requires ChannelManager for thread creation)
  tools.register(
    new SubagentTool(bus, sessions, agentTypes, channels),
  )

  // Register eval bridge routes before starting the server.
  registerEvalBridgeRoute(app)

  // Frontend (registered LAST so the catch-all '*' route does not shadow API
  // routes). Priority:
  //   1. Vite dev server proxy (set VITE_DEV_URL, e.g. http://localhost:5273)
  //      — used by `pnpm dev` so edits hot-reload instead of serving a
  //      stale app/dist build.
  //   2. Built static UI at <cwd>/app/dist (set UI_DIST_DIR to override)
  //   3. Embedded UI at <module>/../app/dist (Electron sidecar
  //      with the bundled frontend assets)
  //   4. Nothing — the gateway just exposes the API.
  const viteDevUrl = env.VITE_DEV_URL
  if (viteDevUrl) {
    devProxyPlugin(viteDevUrl)(app)
  } else {
    const uiDistCandidates = [
      env.UI_DIST_DIR,
      resolve(process.cwd(), 'app', 'dist'),
      import.meta.dirname
        ? resolve(import.meta.dirname, '..', 'app', 'dist')
        : undefined,
    ].filter((path): path is string => Boolean(path))

    let uiDistDir: string | undefined
    for (const candidate of uiDistCandidates) {
      try {
        if ((await nodeStat(candidate)).isDirectory()) {
          uiDistDir = candidate
          break
        }
      } catch { /* missing — try the next candidate */ }
    }

    if (uiDistDir) {
      uiPlugin(uiDistDir)(app)
    } else {
      console.info(
        `[gateway] UI dist not found (looked in: ${
          uiDistCandidates.join(', ')
        }) and VITE_DEV_URL not set — frontend not served`,
      )
    }
  }

  const gateway = serveGateway(app, {
    ...options.gateway,
    clientAddresses,
  })

  // ── Graceful shutdown ─────────────────────────────────────────────
  let shutdownPromise: Promise<void> | undefined
  shutdown = () => {
    shutdownPromise ??= shutdownRuntime()
    return shutdownPromise
  }
  const shutdownRuntime = async () => {
    localControl.markStopping()
    console.info('[main] Shutting down...')
    const closeCluster = mainCluster.closeNodeConnections()
    bus.emit('app.lifecycle', { action: 'stop' })
    clearInterval(pulseTimer)
    bus.stopAll()
    await agent.shutdown()
    await channels.stopAll()
    cronService.stop()
    events.stop()
    await chromeManager.releaseAll()
    await closeCluster
    await gateway.shutdown()
    await mainCluster.save()
    await closeTelemetry()
  }

  // ── Start everything ──────────────────────────────────────────────
  console.info('[main] Starting all services...')

  const startAgent = agent.start()
  const startCron = cronService.start()
  const startGateway = gateway.finished

  // Recover sessions interrupted by the previous process exit.
  sessions.recoverIncompleteSessions().catch((err) =>
    console.warn('[main] Session recovery sweep failed:', err)
  )

  const ready = Promise.all([startAgent, startCron, gateway.ready]).then(() => {})
  const finished = Promise.allSettled([
    startAgent,
    startCron,
    startGateway,
  ]).then(() => {})

  try {
    await ready
  } catch (error) {
    await shutdown().catch(() => {})
    throw error
  }
  localControl.markReady()
  console.info('[main] All services started')
  return { ready, finished, shutdown }
  }
}

export async function runBackendCli(
  hooks: BackendProcessHooks = nodeProcessHooks,
): Promise<void> {
  const { configPath } = parseBackendCliArguments(hooks.argv)
  const config = await loadConfig(configPath)
  const runtime = await startMainRuntime(config, { configPath })
  const detachSignals = attachBackendSignalHandlers(runtime, hooks, {
    includeSigterm: getOs() !== 'windows',
  })
  try {
    await runtime.finished
  } finally {
    detachSignals()
  }
}

export function runRootProcessEntry(
  hooks: BackendProcessHooks = nodeProcessHooks,
): Promise<ProcessEntryResult> {
  return runProcessEntry(hooks.argv, {
    loadConfig,
    startMainRuntime,
    startChildRuntime: (config, paths, context) => {
      if (
        context.loopbackPort !== undefined &&
        context.launchCredential === undefined
      ) {
        throw new TypeError(
          'Child local control requires WINDOWS_USE_LAUNCH_TOKEN',
        )
      }
      return startProductionChildRuntime(config, paths, {
        ...(context.loopbackPort === undefined ? {} : {
          localControl: {
            port: context.loopbackPort,
            launchCredential: context.launchCredential!,
          },
        }),
      })
    },
    runLegacy: () => runBackendCli(hooks),
    runtime: {
      readTextFile: (path) => readFile(path, 'utf8'),
      process: hooks,
      env: {
        GATEWAY_PORT: env.GATEWAY_PORT,
        WINDOWS_USE_LAUNCH_TOKEN: env.WINDOWS_USE_LAUNCH_TOKEN,
      },
      includeSigterm: getOs() !== 'windows',
    },
  })
}

const nodeProcessHooks: BackendProcessHooks = {
  argv: process.argv,
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
  exit: (code) => process.exit(code),
}

if (import.meta.main) {
  runRootProcessEntry().catch((err) => {
    console.error('[main] Fatal error', err)
    process.exit(1)
  })
}
