import { SharedChrome } from '../browser/shared-chrome.ts'
import { bundledChromeAdapter } from '../browser/chrome-adapter.ts'
import { attachmentTarget } from '../browser/session-browsers.ts'
import { McpConnection } from '../mcp/client.ts'
import { createManagedDesktopConnection } from '../desktop-mcp/service.ts'
import { homedir } from 'node:os'
import { ChildMcpService } from '../mcp/child-service.ts'
import { readChildMcpConfig, resolveChildMcpSource, resolveChildManagedMcpGrant } from '../mcp/child-config.ts'
import { assertExecutionSupported } from '../execution/workdir-contracts.ts'
import { RemoteLayerFSService } from '../execution/layerfs/remote-service.ts'
import { RemoteLayerFSRuntimes } from '../execution/layerfs/remote-runtime.ts'
import { LAYERFS_REMOTE_OPERATION, LAYERFS_REMOTE_FEATURE } from '../execution/layerfs/remote-contract.ts'
import { childWorkspacePlugin } from './child-workspace.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { requestDeviceChallengeProtocol } from '../cluster/device-challenge-client.ts'
import { AtomicDeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import {
  ProtectedEd25519DeviceCredentialProvider,
  resolveDeviceCredentialForConnect,
  validateDeviceCredentialReferenceV1,
} from '../cluster/device-credentials.ts'
import { createPlatformDeviceKeyStore } from '../cluster/protected-device-key-stores.ts'
import type { ExecutionSupport } from '../cluster/contracts.ts'
import type { NodeWebSocketFactory } from '../cluster/websocket-node-transport.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { JournaledShellExecutor, ShellJournal } from '../execution/shell-journal.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import { ChildMainConnector } from './child-main-connector.ts'
import {
  type ChildRuntimeHandle,
  type ChildRuntimeService,
  startChildRuntime,
} from './child-runtime.ts'
import type { RuntimeDerivedPaths } from './runtime-cli.ts'
import type { ProtectedDeviceKeyStore } from '../cluster/device-credentials.ts'
import type { DeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import type { ChallengeFetch } from '../cluster/device-challenge-client.ts'
import { ChildLocalControlService } from './child-local-control.ts'
import { childLocalNodeInventory } from './node-inventory.ts'

export interface ProductionChildOptions {
  readonly keyStore?: ProtectedDeviceKeyStore
  readonly referenceStore?: DeviceCredentialReferenceStore
  readonly processManager?: ProcessManager
  readonly webSocketFactory?: NodeWebSocketFactory
  readonly fetchChallenge?: ChallengeFetch
  readonly localControl?: {
    readonly port: number
    readonly launchCredential: string
  }
}

export async function startProductionChildRuntime(
  config: ChildBootstrapConfigV1,
  paths: RuntimeDerivedPaths,
  options: ProductionChildOptions = {},
): Promise<ChildRuntimeHandle> {
  assertChildTransport(config)
  const referenceStore = options.referenceStore ??
    new AtomicDeviceCredentialReferenceStore(paths.childCredentialPath)
  const referenceValue = await referenceStore.load()
  if (referenceValue === null) {
    throw new Error(
      `Child credential reference is missing at "${paths.childCredentialPath}"`,
    )
  }
  const validation = validateDeviceCredentialReferenceV1(referenceValue)
  if (!validation.success) throw new TypeError(validation.errors.join('; '))
  const reference = validation.value
  const keyStore = options.keyStore ??
    createPlatformDeviceKeyStore(paths.dataDir)
  const credentialProvider = new ProtectedEd25519DeviceCredentialProvider(
    keyStore,
  )
  const processManager = options.processManager ?? new ProcessManager()
  // Re-pairing must not advertise a previous Main's managed workdirs.
  const pairingScope = createHash('sha256').update(JSON.stringify([
    new URL(config.mainEndpoint).href, reference.credentialId,
  ])).digest('hex')
  const mcpConfig = await readChildMcpConfig(join(paths.dataDir, 'child-mcp.json'))
  const registeredWorkdirs = config.workdirs ?? []
  const grantedMcpWorkdirs = new Set(registeredWorkdirs.filter(binding => mcpConfig.some(grant =>
    grant.pairingId === reference.credentialId && grant.workdirId === binding.workdirId && (grant.sources.servers.length > 0 || grant.browser || grant.desktop),
  )).map(binding => binding.workdirId))
  const workdirs = new ManagedChildWorkdirs(
    join(paths.dataDir, 'managed-session-workdirs-v1', pairingScope), config.localNodeId, registeredWorkdirs,
    homedir(), config.allowDeviceHome === true, grantedMcpWorkdirs,
  )
  await workdirs.init()
  const browsers = new Map<string, SharedChrome>()
  const mcp = new ChildMcpService(async (request, source, _action, signal) => {
    await workdirs.assertCanExecute(request, signal)
    if (source === 'chrome-devtools' || source === 'agent-desktop') {
      const { grant, cwd } = resolveChildManagedMcpGrant(mcpConfig, reference.credentialId, request, source, registeredWorkdirs)
      const root = join(paths.dataDir, 'managed-mcp-v1', pairingScope, request.projectScope!)
      const config = { name: source, transport: 'stdio' as const }
      if (source === 'agent-desktop') {
        return { config, managed: () => createManagedDesktopConnection(root) }
      }
      if (grant.browser) {
        const choice = grant.browser
        return { config, managed: async () => {
          const adapter = bundledChromeAdapter()
          let browser = browsers.get(root)
          if (!browser) { browser = new SharedChrome(join(root, 'profiles')); browsers.set(root, browser) }
          const endpoint = attachmentTarget(await browser.ensure(choice, signal))
          const launch = { ...config, command: adapter.command, env: adapter.env,
            args: [...adapter.args, '--page-id-routing', ...endpoint.arguments] }
          return { config: launch, connection: new McpConnection(launch, adapter.cwd, cwd), receipt: browser.copyReport() }
        } }
      }
      throw new Error('Child managed source not granted')
    }
    return resolveChildMcpSource(mcpConfig, reference.credentialId, request, source, registeredWorkdirs)
  })
  const layerfsRuntimes = new RemoteLayerFSRuntimes(join(paths.dataDir, 'layerfs-project-services-v1', pairingScope), config.localNodeId, () => ({ online: connection === 'connected', epoch: connectionEpoch, pairingId: reference.credentialId }))
  const layerfsService = new RemoteLayerFSService({ nodeId: config.localNodeId, pairingId: reference.credentialId,
    directory: join(paths.dataDir, 'layerfs-service-receipts-v1', pairingScope),
    // Only the authenticated paired Main can dispatch jobs on this connector. Main
    // injects Project and owner assertions; model tools cannot address this handler.
    authorize: async (request, call, signal) => {
      signal.throwIfAborted()
      if (process.platform !== 'win32' || request.projectScope !== call.authority.projectScope) throw new Error('Target LayerFS service unavailable or Project mismatch')
    }, preflight: call => layerfsRuntimes.preflight(call), dispatch: (call, context, observe) => layerfsRuntimes.dispatch(call, context, observe),
  })
  const support = (): ExecutionSupport => ({ operations: ['process.execute', ...workdirs.support.operations, ...(process.platform === 'win32' ? [LAYERFS_REMOTE_OPERATION] : [])] })
  const journal = new ShellJournal(join(paths.dataDir, 'shell-executions-v1', pairingScope))
  const executor = new JournaledShellExecutor(new LocalExecutor(
    processManager,
    config.localNodeId,
    [...workdirs.operationHandlers, layerfsService, mcp],
    async (request, signal) => {
      if (request.operation === LAYERFS_REMOTE_OPERATION) {
        assertExecutionSupported(request, workdirs.workdirs, support())
        await layerfsService.admit(request, signal)
      } else if (request.workdirId === undefined && request.operation === 'process.execute') assertExecutionSupported(request, workdirs.workdirs, support())
      else await workdirs.assertCanExecute(request, signal)
    },
    request => journal.processResultPath(request),
  ), journal)
  const validateCredential = async (signal: AbortSignal): Promise<void> => {
    await resolveDeviceCredentialForConnect(
      credentialProvider,
      reference,
      {
        endpoint: config.mainEndpoint,
        localNodeId: config.localNodeId,
        signal,
      },
    )
  }
  const connector = new ChildMainConnector({
    localHello: {
      protocolMajor: 1,
      protocolMinor: 0,
      implementationVersion: '0.1.0',
      features: ['workdir-execution-v2', ...(process.platform === 'win32' ? [LAYERFS_REMOTE_FEATURE] : [])],
    },
    authentication: {
      deviceId: reference.deviceId,
      nodeId: reference.nodeId,
      credentialId: reference.credentialId,
    },
    executor,
    support,
    workdirs: () => workdirs.workdirs,
    webSocketFactory: options.webSocketFactory,
    authenticationProtocol: async ({ endpoint, authentication, signal }) => {
      const boundedSignal = AbortSignal.any([signal, AbortSignal.timeout(8_000)])
      const credential = await resolveDeviceCredentialForConnect(
        credentialProvider,
        reference,
        { endpoint, localNodeId: config.localNodeId, signal: boundedSignal },
      )
      return await requestDeviceChallengeProtocol(
        endpoint,
        authentication,
        credential.proof,
        options.fetchChallenge,
        boundedSignal,
      )
    },
    session: { maxOutboundQueue: 128, heartbeatTimeoutMs: 90_000 },
  })
  workdirs.onWorkdir = async workdir => {
    await connector.advertiseWorkdir(workdir)
  }

  let runtime: ChildRuntimeHandle | undefined
  let connection: 'connecting' | 'connected' | 'offline' = 'connecting'
  let connectionError: string | null = null
  let connectionEpoch = 0
  const localControl = options.localControl
    ? new ChildLocalControlService({
      ...options.localControl,
      workspace: childWorkspacePlugin({
        endpoint: config.mainEndpoint,
        proof: async (signal, path) => {
          const credential = await resolveDeviceCredentialForConnect(credentialProvider, reference,
            { endpoint: config.mainEndpoint, localNodeId: config.localNodeId, signal })
          return requestDeviceChallengeProtocol(config.mainEndpoint, {
            deviceId: reference.deviceId, nodeId: reference.nodeId, credentialId: reference.credentialId,
          }, credential.proof, options.fetchChallenge, signal, path)
        },
      }),
      requestShutdown: () => runtime?.shutdown(),
      nodeInventory: () => childLocalNodeInventory(config, workdirs.workdirs, support(), '0.1.0', connection === 'connected' ? 'connected' : 'offline'),
      childStatus: () => ({
        version: 1, nodeId: config.localNodeId, mainEndpoint: config.mainEndpoint,
        connection, error: connectionError, fingerprint: reference.deviceIdentityFingerprint,
        dataDir: paths.dataDir, workdirs: config.workdirs ?? [],
        allowInsecureLocalTransport: config.allowInsecureLocalTransport ?? false,
      }),
    })
    : undefined
  runtime = startChildRuntime(config, {
    nodeIdentity: new CredentialIdentityService(validateCredential),
    localExecutors: new LocalExecutorService(processManager, workdirs, async () => { await Promise.all([layerfsRuntimes.close(), mcp.reset(), ...[...browsers.values()].map(browser => browser.shutdown())]) }),
    mainConnector: connector,
    localControl,
  }, { connectionChanged: (state, error) => {
    if (connection !== state) connectionEpoch++
    connection = state
    connectionError = error
    if (state !== 'connected') void mcp.reset().catch(() => console.error('[child] MCP disconnect cleanup failed'))
  } })
  if (localControl) {
    runtime.ready.then(() => localControl.markReady(), () => {})
  }
  return runtime
}

class CredentialIdentityService implements ChildRuntimeService {
  constructor(readonly validate: (signal: AbortSignal) => Promise<void>) {}

  start(signal: AbortSignal): Promise<void> {
    return this.validate(signal)
  }

  shutdown(): Promise<void> {
    return Promise.resolve()
  }
}

class LocalExecutorService implements ChildRuntimeService {
  constructor(readonly processManager: ProcessManager, readonly workdirs: ManagedChildWorkdirs, readonly closeLayerFS?: () => Promise<void>) {}

  start(_signal: AbortSignal): Promise<void> {
    return Promise.resolve()
  }

  async shutdown(): Promise<void> {
    const running = this.processManager.list().filter((process) =>
      process.exitedAt === undefined
    )
    await Promise.all(running.map((process) => this.processManager.terminate(process)))
    await this.workdirs.settleAllocations()
    await this.closeLayerFS?.()
  }
}

function assertChildTransport(config: ChildBootstrapConfigV1): void {
  const endpoint = new URL(config.mainEndpoint)
  if (
    endpoint.protocol === 'http:' &&
    !config.allowInsecureLocalTransport &&
    !['localhost', '127.0.0.1', '::1'].includes(endpoint.hostname)
  ) {
    throw new TypeError(
      'Non-loopback Child transport requires https or explicit local opt-in',
    )
  }
}
