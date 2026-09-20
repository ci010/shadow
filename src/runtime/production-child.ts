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
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import type { NodeWebSocketFactory } from '../cluster/websocket-node-transport.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
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
  const workdirs = new ManagedChildWorkdirs(
    join(paths.dataDir, 'managed-session-workdirs-v1', pairingScope), config.localNodeId, config.workdirs ?? [],
  )
  await workdirs.init()
  const capabilities = (): CapabilityDescriptorV1[] => [
    {
      version: 1,
      capabilityId: 'process-execute',
      nodeId: config.localNodeId,
      kind: 'shell',
      displayName: 'Local shell',
      permissions: ['process.execute'],
      online: true,
    },
    ...workdirs.capabilities,
  ]
  const executor = new LocalExecutor(
    processManager,
    config.localNodeId,
    workdirs.operationHandlers,
    ['process-execute'],
  )
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
      features: ['jobs-v1', 'capabilities-v1', 'workdir-display-v1'],
    },
    authentication: {
      deviceId: reference.deviceId,
      nodeId: reference.nodeId,
      credentialId: reference.credentialId,
    },
    executor,
    capabilities,
    webSocketFactory: options.webSocketFactory,
    authenticationProtocol: async ({ endpoint, authentication, signal }) => {
      const credential = await resolveDeviceCredentialForConnect(
        credentialProvider,
        reference,
        { endpoint, localNodeId: config.localNodeId, signal },
      )
      return await requestDeviceChallengeProtocol(
        endpoint,
        authentication,
        credential.proof,
        options.fetchChallenge,
        signal,
      )
    },
    session: { maxOutboundQueue: 128, heartbeatTimeoutMs: 90_000 },
  })
  workdirs.onCapability = capability => connector.advertiseCapability(capability)

  let runtime: ChildRuntimeHandle | undefined
  const localControl = options.localControl
    ? new ChildLocalControlService({
      ...options.localControl,
      requestShutdown: () => runtime?.shutdown(),
      nodeInventory: () => childLocalNodeInventory(config, capabilities(), '0.1.0'),
    })
    : undefined
  runtime = startChildRuntime(config, {
    nodeIdentity: new CredentialIdentityService(validateCredential),
    localExecutors: new LocalExecutorService(processManager, workdirs),
    mainConnector: connector,
    localControl,
  })
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
  constructor(readonly processManager: ProcessManager, readonly workdirs: ManagedChildWorkdirs) {}

  start(_signal: AbortSignal): Promise<void> {
    return Promise.resolve()
  }

  async shutdown(): Promise<void> {
    const running = this.processManager.list().filter((process) =>
      process.exitedAt === undefined
    )
    await Promise.all(running.map((process) => this.processManager.terminate(process)))
    await this.workdirs.settleAllocations()
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
