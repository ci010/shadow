import { Hono } from 'hono'
import { resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import type { MainRuntimeHandle, MainRuntimeOptions } from './contracts.ts'
import { resolveUiDistDirectory } from './paths.ts'
import type { Config } from '../../config/schema.ts'
import { CopilotAuthenticator } from '../../providers/copilot.ts'
import { ProviderSetup } from '../../providers/setup.ts'
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
import { projectPaths, projectBasePath } from '../../projects/contracts.ts'
import { registerProjectGateway } from '../../projects/gateway.ts'
import type { ProjectRuntime, ProjectRuntimeFactory } from '../../projects/runtime.ts'
import { reserveRemoteSessionWorkdirs } from '../../projects/session-ownership.ts'
import { OtelStore } from '../../otel/store.ts'
import { initializeNodeTelemetry } from '../../otel/runtime.ts'
import { otelPlugin } from '../../otel/routes.ts'
import { ChromePortAllocator } from '../../browser/chrome-manager.ts'
import { RealtimeHub, registerRealtimeRoute } from '../../realtime/hub.ts'

export async function startProjectHost(
  config: Config,
  options: MainRuntimeOptions,
  factory: ProjectRuntimeFactory,
  selfCodeRoot: string,
): Promise<MainRuntimeHandle> {
  const baseHome = resolve(config.agent.workspace)
  const hostHome = `${baseHome}.projects`
  const catalog = new ProjectCatalog(hostHome, [baseHome])
  await catalog.init()
  for (const project of catalog.list()) {
    await reserveRemoteSessionWorkdirs(projectPaths(hostHome, project.id).home, catalog, project.id)
  }

  const cleanup: Array<() => unknown> = []
  try {
    return await startHostServices()
  } catch (error) {
    for (const close of cleanup.reverse()) {
      try { await close() } catch (cleanupError) { console.error('[projects] Host startup cleanup failed', cleanupError) }
    }
    throw error
  }

  async function startHostServices(): Promise<MainRuntimeHandle> {
  const app = new Hono()
  const realtimeHub = new RealtimeHub()
  cleanup.push(() => realtimeHub.close())
  const hostOtelStore = new OtelStore(resolve(hostHome, '.host.otel.db'))
  let hostTelemetry: ReturnType<typeof initializeNodeTelemetry>
  try { hostTelemetry = initializeNodeTelemetry(hostOtelStore, { serviceName: 'shadow-host' }) }
  catch (error) { hostOtelStore.close(); throw error }
  let telemetryClosed: Promise<void> | undefined
  const closeTelemetry = () => telemetryClosed ??= hostTelemetry.shutdown().finally(() => hostOtelStore.close())
  cleanup.push(closeTelemetry)
  const clientAddresses = new GatewayClientAddressRegistry()
  const launchCredential = resolveLaunchCredential(options.gateway?.launchCredential, process.env.GATEWAY_LAUNCH_CREDENTIAL, process.env.WINDOWS_USE_LAUNCH_TOKEN)
  const authorize = (request: Request) => authorizeMainNodeInventory(request, launchCredential, clientAddresses)
  const runtimes = new Map<string, ProjectRuntime>()
  const scopes = new Map<string, ReturnType<typeof createProjectScope>>()
  const stores = new Map<string, ProjectConfigStore>()
  const starts = new Map<string, Promise<void>>()
  const failures = new Map<string, string>()
  let stopping = false
  let activeConfig = config
  const copilotAuth = new CopilotAuthenticator()
  const chromePortAllocator = new ChromePortAllocator()
  let provider = createAggregatedProvider(config, copilotAuth)
  const mainCluster = await createMainCluster({
    authorizeInventory: authorize,
    localNodeInventory: () => mainLocalNodeInventory({
      localNodeId: options.localNodeId ?? 'local', implementationVersion: '0.1.0', shellAvailable: true,
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
    snapshotAdapter: new AtomicFileRegistrySnapshotAdapter(options.clusterSnapshotPath ?? resolve(baseHome, '.cluster', 'registry.v1.json')),
    localHello: { protocolMajor: 1, protocolMinor: 0, implementationVersion: '0.1.0', features: ['jobs-v1', 'capabilities-v1', 'workdir-display-v1'] },
    authorizeOfferCreation: request => launchCredential ? validateLaunchCredential(request.headers.get('Authorization') ?? undefined, launchCredential) : false,
    clientKey: request => clientAddresses.resolve(request),
  })
  cleanup.push(() => mainCluster.closeNodeConnections())
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
  const providerSetup = new ProviderSetup({ store: sharedConfigStore, getConfig: () => activeConfig, auth: copilotAuth })
  cleanup.push(() => providerSetup.dispose())
  let gatewayBaseUrl = `http://127.0.0.1:${options.gateway?.port ?? process.env.GATEWAY_PORT ?? process.env.REST_API_PORT ?? 3123}`
  const start = (id: string): Promise<void> => {
    if (stopping) return Promise.reject(new Error('Project host is stopping'))
    if (runtimes.has(id)) return Promise.resolve()
    const pending = starts.get(id)
    if (pending) return pending
    const work = (async () => {
      const project = catalog.get(id)
      if (!project) throw new Error('Project not found')
      const scope = createProjectScope(id)
      scopes.set(id, scope)
      const paths = projectPaths(hostHome, id)
      const store = new ProjectConfigStore({
        configPath: paths.configPath, home: paths.home, getSharedConfig: () => activeConfig,
        onChanged: changed => runtimes.get(id)?.updateConfig(changed),
      })
      let runtime: ProjectRuntime | undefined
      try {
        const projectConfig = await store.init()
        runtime = await scope.run(() => factory(projectConfig, {
          project, home: paths.home, scope, catalog, configStore: store,
          mainCluster, copilotAuth, chromePortAllocator, authorize, gatewayBaseUrl: gatewayBaseUrl + projectBasePath(id), selfCodeRoot, realtimeHub,
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
  registerGatewayRoutes(app, [...mainCluster.plugins, localControl.plugin(), providerSetup.plugin(), appModelDefaultsPlugin(sharedConfigStore), providerPlugin(() => provider, () => providerSetup.status())], {
    launchCredential, launchCredentialExemptions: MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS,
  })
  registerRealtimeRoute(app, realtimeHub, authorize)
  const hostDiagnostics = new Hono()
  otelPlugin(hostOtelStore)(hostDiagnostics)
  app.route('/host', hostDiagnostics)
  registerProjectGateway(app, {
    catalog, start, clientAddresses,
    lookup: id => {
      const runtime = runtimes.get(id)
      const scope = scopes.get(id)
      return runtime && scope ? { app: runtime.app, run: callback => scope.run(callback) } : undefined
    },
    status: id => runtimes.has(id) ? { state: 'ready' } : failures.has(id)
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
  let shutdownPromise: Promise<void> | undefined
  shutdown = () => shutdownPromise ??= (async () => {
    stopping = true
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
    await clean(() => providerSetup.dispose())
    await clean(() => mainCluster.closeNodeConnections())
    await clean(() => gateway.shutdown())
    await clean(() => mainCluster.save())
    await clean(closeTelemetry)
    if (errors.length) throw new AggregateError(errors, 'Main shutdown failed')
  })()
  try {
    await gateway.ready
    gatewayBaseUrl = `http://127.0.0.1:${gateway.addr.port}`
    for (const project of catalog.list()) await start(project.id)
    localControl.markReady()
  } catch (error) {
    await shutdown().catch(cleanup => console.error('[projects] Host cleanup failed', cleanup))
    throw error
  }
  return { ready: Promise.resolve(), finished: gateway.finished, shutdown }
  }
}
