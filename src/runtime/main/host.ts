import { measureStartupProfile, startupProjectOrdinal } from '../startup-profile.ts'
import { appProxyPlugin } from '../../config/proxy-routes.ts'
import { updateBackendNetwork } from '../../execution/network/backend.ts'
import { Hono } from 'hono'
import { dirname, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { appDataPaths } from '../../utils/data-paths.ts'
import type { MainRuntimeHandle, MainRuntimeOptions } from './contracts.ts'
import { resolveUiDistDirectory } from './paths.ts'
import type { Config } from '../../config/schema.ts'
import { CopilotAuthenticatorV2 } from '../../providers/copilot-v2.ts'
import { ProviderSetup } from '../../providers/setup.ts'
import { RuntimeDiagnosticLog } from '../diagnostic-log.ts'
import { createAggregatedProvider } from '../../providers/factory.ts'
import { providerPlugin } from '../../providers/routes.ts'
import { createMainCluster, MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS } from '../../cluster/main-cluster.ts'
import { AtomicFileRegistrySnapshotAdapter } from '../../cluster/persistence.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, resolveLaunchCredential, serveGateway, validateLaunchCredential } from '../../gateway/server.ts'
import { authorizeMainNodeInventory, mainLocalNodeInventory } from '../node-inventory.ts'
import { LocalRuntimeControl } from '../local-control.ts'
import { devProxyPlugin } from '../../gateway/dev-proxy.ts'
import { uiPlugin } from '../../gateway/ui.ts'
import { createProjectScope } from '../../projects/scope.ts'
import { ProjectCatalog } from '../../projects/catalog.ts'
import { AppProviderConfigStore, ProjectConfigStore } from '../../projects/config-store.ts'
import { appModelDefaultsPlugin } from '../../config/model-routes.ts'
import { appWebSearchPlugin } from '../../config/web-search-routes.ts'
import { projectPaths, projectBasePath } from '../../projects/contracts.ts'
import { registerProjectGateway } from '../../projects/gateway.ts'
import type { ProjectRuntime, ProjectRuntimeFactory } from '../../projects/runtime.ts'
import { reserveRemoteSessionWorkdirs, type StartupOwnershipStates } from '../../projects/session-ownership.ts'
import { OtelStore } from '../../otel/store.ts'
import { initializeNodeTelemetry } from '../../otel/runtime.ts'
import { otelPlugin } from '../../otel/routes.ts'
import { RealtimeHub, registerRealtimeRoute } from '../../realtime/hub.ts'
import { StartupTimings } from '../startup-timings.ts'
import { BrowserAuth } from '../../gateway/web-auth.ts'
import { MainDeviceUi } from '../../cluster/device-ui.ts'
import { MainDeviceNetwork } from './device-network.ts'
import { MobileAccess, mobileGatewayConfig } from '../../gateway/mobile-access.ts'
import { a2aRequestProject } from '../../a2a/config.ts'
import { FolderError } from '../../folders/registry.ts'
import { ComputerService } from '../../computer/service.ts'
import { createComputerDesktop } from '../../execution/computer/factory.ts'

export async function startProjectHost(
  config: Config,
  options: MainRuntimeOptions,
  factory: ProjectRuntimeFactory,
): Promise<MainRuntimeHandle> {
  const startup = new StartupTimings('host')
  const baseHome = resolve(config.agent.workspace)
  const appPaths = appDataPaths(options.dataDir ?? baseHome)
  const hostHome = appPaths.root
  const catalog = new ProjectCatalog(hostHome, [baseHome])
  await startup.measure('catalog', () => catalog.init())
  for (const project of catalog.list()) {
    if (catalog.isDeleting(project.id)) {
      try { await catalog.remove(project.id) }
      catch (error) { console.error(`[projects:${project.id}] Pending deletion could not finish; retry from the project catalog`, error) }
    }
  }
  const startupSessionStates = new Map<string, StartupOwnershipStates>()
  const failures = new Map<string, string>()
  const inspectSessionOwnership = async (id: string): Promise<StartupOwnershipStates | undefined> => {
    const snapshot: StartupOwnershipStates = {}
    catalog.setSessionOwnershipAvailable(id, false)
    try {
      await measureStartupProfile('ownership-project', () =>
        reserveRemoteSessionWorkdirs(projectPaths(hostHome, id).home, catalog, id, snapshot),
      { projectOrdinal: startupProjectOrdinal(id) })
      catalog.setSessionOwnershipAvailable(id, true)
      return snapshot
    } catch {
      const message = 'Session storage could not be validated. Original data is preserved. Repair the project session data and retry.'
      failures.set(id, message)
      // Never log parser messages: malformed JSON can contain private conversation data.
      console.error(`[projects:${id}] session_storage_unavailable: ${message}`)
      return undefined
    }
  }
  await startup.measure('ownership', async () => {
    for (const project of catalog.list()) {
      if (catalog.isDeleting(project.id)) continue
      const snapshot = await inspectSessionOwnership(project.id)
      if (snapshot) startupSessionStates.set(project.id, snapshot)
    }
  })

  const cleanup: Array<() => unknown> = []
  try {
    return await startHostServices()
  } catch (error) {
    for (const close of cleanup.reverse()) {
      try { await close() } catch (cleanupError) { console.error('[projects] Host startup cleanup failed', cleanupError) }
    }
    throw error
  } finally {
    startupSessionStates.clear()
  }

  async function startHostServices(): Promise<MainRuntimeHandle> {
  const app = new Hono()
  const realtimeHub = new RealtimeHub({ projectExists: id => !!catalog.get(id) })
  cleanup.push(() => realtimeHub.close())
  cleanup.push(catalog.observeProjects(() => realtimeHub.invalidateProjects()))
  const hostOtelStore = new OtelStore(appPaths.hostTelemetry)
  let hostTelemetry: ReturnType<typeof initializeNodeTelemetry>
  try { hostTelemetry = initializeNodeTelemetry(hostOtelStore, { serviceName: 'shadow-host' }) }
  catch (error) { hostOtelStore.close(); throw error }
  let telemetryClosed: Promise<void> | undefined
  const closeTelemetry = () => telemetryClosed ??= hostTelemetry.shutdown().finally(() => hostOtelStore.close())
  cleanup.push(closeTelemetry)
  const clientAddresses = new GatewayClientAddressRegistry()
  const launchCredential = resolveLaunchCredential(options.gateway?.launchCredential, process.env.GATEWAY_LAUNCH_CREDENTIAL, process.env.WINDOWS_USE_LAUNCH_TOKEN)
  const browserAuth = new BrowserAuth({ launchCredential, pinHash: options.gateway?.browserPinHash, clientAddresses, developmentUrl: process.env.VITE_DEV_URL })
  cleanup.push(() => browserAuth.close())
  const mobileConfig = mobileGatewayConfig(process.env)
  const mobileAccess = mobileConfig ? new MobileAccess({
    publicOrigin: mobileConfig.publicOrigin, allowLanHttp: mobileConfig.allowLanHttp, launchCredential: launchCredential ?? '', clientAddresses,
  }) : undefined
  if (mobileConfig?.publicOrigin.startsWith('http:')) console.warn('WARNING: LAN HTTP is unencrypted. Pairing codes, tokens and conversations are exposed to the network. Use only a trusted LAN; prefer HTTPS.')
  if (mobileAccess) cleanup.push(() => mobileAccess.close())
  let deviceUi: MainDeviceUi | undefined
  const authorize = (request: Request) => !!deviceUi?.authorize(request) || !!mobileAccess?.authorizeMain(request) || browserAuth.authorize(request)
    || ((!browserAuth.required || !!launchCredential) && authorizeMainNodeInventory(request, launchCredential, clientAddresses))
  const runtimes = new Map<string, ProjectRuntime>()
  const scopes = new Map<string, ReturnType<typeof createProjectScope>>()
  const stores = new Map<string, ProjectConfigStore>()
  const starts = new Map<string, Promise<void>>()
  const deletions = new Set<string>()
  let stopping = false
  let activeConfig = config
  const copilotAuth = new CopilotAuthenticatorV2()
  const computer = new ComputerService(createComputerDesktop(), { enabled: options.localExecutor !== false })
  cleanup.push(() => computer.close())
  let provider = createAggregatedProvider(config, copilotAuth)
  const mainCluster = await startup.measure('cluster', () => createMainCluster({
    authorizeInventory: authorize,
    localNodeInventory: () => mainLocalNodeInventory({
      localNodeId: options.localNodeId ?? 'local', implementationVersion: '0.1.0', shellAvailable: options.localExecutor !== false,
      folders: {
        list: () => catalog.folders(),
        lookupWorkdir: ref => {
          for (const runtime of runtimes.values()) {
            const result = runtime.folders.lookupWorkdir(ref)
            if (result?.capability) return result
          }
          return { node: 'online' }
        },
      },
    }),
    snapshotAdapter: new AtomicFileRegistrySnapshotAdapter(options.clusterSnapshotPath ?? resolve(appPaths.devices, 'registry.v1.json')),
    localHello: { protocolMajor: 1, protocolMinor: 0, implementationVersion: '0.1.0', features: ['jobs-v1', 'capabilities-v1', 'workdir-display-v1'] },
    authorizeOfferCreation: request => launchCredential ? validateLaunchCredential(request.headers.get('Authorization') ?? undefined, launchCredential) : false,
    clientKey: request => clientAddresses.resolve(request),
  }))
  cleanup.push(() => mainCluster.closeNodeConnections())
  deviceUi = new MainDeviceUi(mainCluster, clientAddresses, request => Promise.resolve(app.fetch(request)), process.env.VITE_DEV_URL)
  cleanup.push(() => deviceUi?.close())
  const deviceNetwork = new MainDeviceNetwork({
    uiPlugin: deviceUi.plugin(),
    configPath: resolve(options.clusterSnapshotPath ? dirname(options.clusterSnapshotPath) : appPaths.devices, 'device-network.v1.json'),
    cluster: mainCluster,
    clientAddresses,
    authorize: request => launchCredential ? validateLaunchCredential(request.headers.get('Authorization') ?? undefined, launchCredential) : false,
  })
  cleanup.push(() => deviceNetwork.shutdown())
  await deviceNetwork.init()
  const sharedConfigStore = new AppProviderConfigStore({
    configPath: options.configPath,
    getConfig: () => activeConfig,
    onChanged: async changed => {
      const updatedProvider = createAggregatedProvider(changed, copilotAuth)
      const previous = activeConfig
      const previousProvider = provider
      activeConfig = changed
      provider = updatedProvider
      try {
        for (const [id, store] of stores) await scopes.get(id)?.run(() => store.refreshShared())
        await updateBackendNetwork(changed.network?.proxyEnabled ?? true)
      } catch (error) {
        activeConfig = previous
        provider = previousProvider
        for (const [id, store] of stores) {
          try { await scopes.get(id)?.run(() => store.refreshShared()) }
          catch (restoreError) { console.error(`[projects:${id}] Provider rollback failed`, restoreError) }
        }
        throw error
      }
      providerSetup.invalidate()
    },
  })
  if (options.configPath) await sharedConfigStore.read()
  const diagnostics = new RuntimeDiagnosticLog()
  const providerSetup = new ProviderSetup({ diagnostics, store: sharedConfigStore, getConfig: () => activeConfig, auth: copilotAuth })
  cleanup.push(() => providerSetup.dispose())
  const start = (id: string): Promise<void> => {
    if (stopping) return Promise.reject(new Error('Project host is stopping'))
    if (deletions.has(id) || catalog.isDeleting(id)) return Promise.reject(new FolderError('project_deleting', 'Project deletion is pending.', 409))
    if (runtimes.has(id)) return Promise.resolve()
    const pending = starts.get(id)
    if (pending) return pending
    const work = (async () => {
      const project = catalog.get(id)
      if (!project) throw new Error('Project not found')
      const startupStates = startupSessionStates.get(id) ?? await inspectSessionOwnership(id)
      startupSessionStates.delete(id) // Retries must read current state, never reuse failed boot data.
      if (!startupStates || stopping) return
      const scope = createProjectScope(id)
      scopes.set(id, scope)
      const paths = projectPaths(hostHome, id)
      const store = new ProjectConfigStore({
        configPath: paths.configPath, home: paths.home, getSharedConfig: () => activeConfig,
        onChanged: changed => runtimes.get(id)?.updateConfig(changed),
      })
      let runtime: ProjectRuntime | undefined
      try {
        const projectStartup = new StartupTimings('project', id)
        const projectConfig = await projectStartup.measure('config', () => store.init())
        runtime = await scope.run(() => factory(projectConfig, {
          startupSessionStates: startupStates,
          project, home: paths.home, scope, catalog, configStore: store, diagnostics,
          mainCluster, copilotAuth, authorize, realtimeHub, computer,
          localExecutor: options.localExecutor !== false,
        }))
        await runtime.ready
        if (stopping) {
          await scope.run(() => runtime!.shutdown())
          scope.close()
          return
        }
        stores.set(id, store)
        runtimes.set(id, runtime)
        failures.delete(id)
        realtimeHub.projectReady(id)
      } catch (error) {
        if (runtime) await scope.run(() => runtime!.shutdown()).catch(cleanup => console.error(`[projects:${id}] Cleanup failed`, cleanup))
        scope.close()
        scopes.delete(id)
        failures.set(id, 'Project could not start. Check host diagnostics and retry.')
        console.error(`[projects:${id}] Startup failed`, error)
      }
    })()
    starts.set(id, work)
    void work.finally(() => starts.delete(id)).catch(error => console.error('[projects] Startup failed', error))
    return work
  }
  let shutdown: () => Promise<void>
  const localControl = new LocalRuntimeControl('main', () => shutdown())
  registerGatewayRoutes(app, [browserAuth.plugin(), ...(mobileAccess ? [mobileAccess.managementPlugin()] : []), ...mainCluster.plugins, deviceNetwork.plugin(), localControl.plugin(), providerSetup.plugin(), appModelDefaultsPlugin(sharedConfigStore), appWebSearchPlugin(sharedConfigStore, () => activeConfig), appProxyPlugin(sharedConfigStore, () => activeConfig), providerPlugin(() => provider, () => providerSetup.status())], {
    launchCredential, browserAuth, clientAddresses, authorizeClient: request => {
      if (mobileAccess?.authorizeMain(request) || deviceUi?.authorize(request)) return true
      const projectId = a2aRequestProject(request)
      return projectId && !deletions.has(projectId) && !catalog.isDeleting(projectId)
        ? runtimes.get(projectId)?.authorizeA2a?.(request) ?? false : false
    },
    launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  })
  registerRealtimeRoute(app, realtimeHub, authorize)
  const hostDiagnostics = new Hono()
  otelPlugin(hostOtelStore)(hostDiagnostics)
  app.route('/host', hostDiagnostics)
  registerProjectGateway(app, {
    catalog, start, clientAddresses,
    remove: async id => {
      if (deletions.has(id)) throw new FolderError('project_busy', 'Project deletion is already running.', 409)
      deletions.add(id)
      try {
        await starts.get(id)
        await catalog.remove(id, async () => {
          const runtime = runtimes.get(id)
          const scope = scopes.get(id)
          // Revoke HTTP and A2A admission before draining the runtime.
          stores.delete(id)
          if (runtime && scope) await scope.run(() => runtime.shutdown())
          runtimes.delete(id)
          scope?.close()
          scopes.delete(id)
          failures.delete(id)
        })
      } finally { deletions.delete(id) }
    },
    lookup: id => {
      const runtime = !deletions.has(id) && runtimes.get(id)
      const scope = scopes.get(id)
      return runtime && scope ? { app: runtime.app, run: callback => scope.run(callback) } : undefined
    },
    status: id => catalog.isDeleting(id) ? { state: 'failed', error: 'Deletion is pending. Retry deleting this project.' }
      : runtimes.has(id) ? { state: 'ready' } : failures.has(id)
      ? { state: 'failed', error: failures.get(id) } : { state: 'starting' },
  })
  if (process.env.VITE_DEV_URL) devProxyPlugin(process.env.VITE_DEV_URL)(app)
  else {
    const candidates = [process.env.UI_DIST_DIR, resolve(process.cwd(), 'app', 'dist'),
      resolveUiDistDirectory(import.meta.dirname)]
    for (const candidate of candidates) {
      if (!candidate) continue
      try {
        if ((await stat(candidate)).isDirectory()) { uiPlugin(candidate)(app); break }
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error
      }
    }
  }
  const gateway = serveGateway(app, { ...options.gateway, clientAddresses })
  cleanup.push(() => gateway.shutdown())
  const mobileGateway = mobileAccess && mobileConfig
    ? serveGateway(mobileAccess.createGateway(app), { host: mobileConfig.publicOrigin.startsWith('http:') ? new URL(mobileConfig.publicOrigin).hostname.replace(/^\[|\]$/g, '') : '127.0.0.1', port: mobileConfig.port, clientAddresses })
    : undefined
  if (mobileGateway) cleanup.push(() => mobileGateway.shutdown())
  let shutdownPromise: Promise<void> | undefined
  shutdown = () => shutdownPromise ??= (async () => {
    stopping = true
    browserAuth.close()
    deviceUi?.close()
    mobileAccess?.close()
    realtimeHub.close()
    localControl.markStopping()
    const errors: unknown[] = []
    const clean = async (operation: () => unknown) => {
      try { await operation() } catch (error) {
        if (error instanceof AggregateError) errors.push(...error.errors)
        else errors.push(error)
      }
    }
    await clean(() => Promise.allSettled(starts.values()))
    for (const [id, runtime] of runtimes) {
      const scope = scopes.get(id)!
      await clean(() => scope.run(() => runtime.shutdown()))
      scope.close()
    }
    runtimes.clear()
    stores.clear()
    await clean(() => computer.close())
    await clean(() => providerSetup.dispose())
    await clean(() => deviceNetwork.shutdown())
    await clean(() => mainCluster.closeNodeConnections())
    await clean(() => gateway.shutdown())
    if (mobileGateway) await clean(() => mobileGateway.shutdown())
    await clean(() => mainCluster.save())
    await clean(closeTelemetry)
    if (errors.length) throw new AggregateError(errors, 'Main shutdown failed')
  })()
  try {
    await startup.measure('gateway', () => Promise.all([gateway.ready, ...(mobileGateway ? [mobileGateway.ready] : [])]))
    await startup.measure('projects', async () => {
      // Bound disk/watcher pressure while avoiding one slow Project delaying every other start.
      const projects = catalog.list()[Symbol.iterator]()
      const worker = async () => {
        for (const project of projects) {
          if (!catalog.isDeleting(project.id) && !failures.has(project.id)) await start(project.id)
        }
      }
      await Promise.all(Array.from({ length: Math.min(3, catalog.list().length) }, worker))
    })
    startupSessionStates.clear()
    localControl.markReady()
    startup.ready()
  } catch (error) {
    await shutdown().catch(cleanup => console.error('[projects] Host cleanup failed', cleanup))
    throw error
  }
  return { ready: Promise.resolve(), finished: mobileGateway ? Promise.race([gateway.finished, mobileGateway.finished]) : gateway.finished, shutdown }
  }
}
