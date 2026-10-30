import type { GatewayPlugin } from '../gateway/types.ts'
import type { Context, Next } from 'hono'
import type { VersionHelloV1 } from './contracts.ts'
import {
  decodeBase64Url,
  DeviceChallengeAuthority,
  devicePublicKeyFingerprint,
} from './device-challenge.ts'
import { deviceChallengeApiPlugin } from './device-challenge-api.ts'
import {
  createNodeWebSocketApi,
  type NodeWebSocketApi,
} from './node-websocket-api.ts'
import { pairingApiPlugin } from './pairing-api.ts'
import { nodeAdministrationApiPlugin } from './node-administration-api.ts'
import {
  mainNodeInventory,
  nodeInventoryApiPlugin,
  type NodeInventoryEntry,
  type NodeInventoryResponse,
} from './node-inventory.ts'
import {
  type RegistrySnapshotAdapter,
  RegistrySnapshotCoordinator,
} from './persistence.ts'
import { PinPairingService } from './pin-pairing.ts'
import {
  type ApprovalV1,
  type DeviceAuthenticationV1,
  InMemoryPairingNodeRegistry,
} from './registry.ts'
import { RemoteExecutor } from '../execution/remote-executor.ts'
import type { WorkdirLookup } from '../sessions/locality.ts'

export const MAIN_CLUSTER_LAUNCH_CREDENTIAL_EXEMPTIONS = [
  { method: 'POST', path: '/pair/v1/present' },
  { method: 'POST', path: '/cluster/v1/challenges' },
  { method: 'GET', path: '/cluster/v1/node' },
] as const

export interface MainClusterOptions {
  readonly snapshotAdapter: RegistrySnapshotAdapter
  readonly localHello: VersionHelloV1
  readonly authorizeOfferCreation: (
    request: Request,
  ) => boolean | Promise<boolean>
  readonly clientKey: (request: Request) => string
  readonly localNodeInventory?: () => NodeInventoryEntry
  readonly authorizeInventory?: (
    request: Request,
  ) => boolean | Promise<boolean>
  readonly now?: () => Date
}

export interface MainCluster {
  readonly registry: InMemoryPairingNodeRegistry
  readonly authority: DeviceChallengeAuthority
  readonly plugins: readonly GatewayPlugin[]
  readonly activeSessionCount: number
  readonly remoteExecutor: RemoteExecutor
  readonly workdirLookup: WorkdirLookup
  observeInventory(observer: () => void): () => void
  getNodeInventory(): NodeInventoryResponse
  approve(approval: ApprovalV1, now?: Date): Promise<DeviceAuthenticationV1>
  revoke(nodeId: string, now?: Date): Promise<void>
  closeNodeConnections(reason?: string): Promise<void>
  save(now?: Date): Promise<void>
}

export async function createMainCluster(
  options: MainClusterOptions,
): Promise<MainCluster> {
  const inventoryObservers = new Set<() => void>()
  const inventoryChanged = () => {
    for (const observer of inventoryObservers) {
      try { observer() } catch { console.warn('[cluster] Inventory observer failed') }
    }
  }
  const now = options.now ?? (() => new Date())
  const registry = new InMemoryPairingNodeRegistry()
  const persistence = new RegistrySnapshotCoordinator(
    registry,
    options.snapshotAdapter,
  )
  const restored = await persistence.restore(now())
  if (restored) {
    const staleOffers = registry.exportSnapshot(now()).offers
    for (const offer of staleOffers) registry.invalidateOffer(offer.offerId)
    if (staleOffers.length > 0) await persistence.save(now())
  }

  const authority = new DeviceChallengeAuthority(registry)
  await authority.restoreRegisteredCredentials()
  const pairing = new PinPairingService(registry, {
    onRegistryMutation: (mutationTime) => persistence.save(mutationTime),
  })
  const nodeApi: NodeWebSocketApi = createNodeWebSocketApi({
    registry,
    localHello: options.localHello,
    authorizeUpgrade: (request) => authority.verifyWebSocketRequest(request),
    session: {
      maxOutboundQueue: 128,
      heartbeatTimeoutMs: 90_000,
      onConnectionChange: inventoryChanged,
      onRegistryMutation: async (mutationTime) => { await persistence.save(mutationTime); inventoryChanged() },
    },
  })
  const remoteExecutor = new RemoteExecutor(nodeApi)
  const getNodeInventory = (): NodeInventoryResponse =>
    mainNodeInventory(options.localNodeInventory?.(), registry, nodeApi)
  const workdirLookup: WorkdirLookup = (ref) => {
    const nodeState = registry.getNodeState(ref.nodeId)
    if (nodeState === 'missing') return { node: 'missing' }
    if (nodeState === 'revoked') return { node: 'revoked' }
    if (!nodeApi.isNodeConnected(ref.nodeId)) return { node: 'offline' }
    if (!nodeApi.supportsExecutionProtocol(ref.nodeId)) return { node: 'online', incompatible: true }
    const workdir = registry.listWorkdirs(ref.nodeId).find((value) =>
      value.workdirId === ref.workdirId
    )
    return {
      node: 'online',
      ...(workdir
        ? { workdir: {
          online: workdir.online &&
            nodeApi.hasAdvertisedWorkdir(workdir.nodeId, workdir.workdirId),
        } }
        : {}),
    }
  }
  const approve = async (
    approval: ApprovalV1,
    approvalTime = now(),
  ): Promise<DeviceAuthenticationV1> => {
    const pending = registry.getPending().find((record) =>
      record.pendingId === approval.pendingId
    )
    if (!pending?.devicePublicKey) {
      throw new TypeError('Pending device has no Ed25519 public key')
    }
    const publicKey = decodeBase64Url(pending.devicePublicKey)
    if (
      publicKey.length !== 32 ||
      await devicePublicKeyFingerprint(publicKey) !==
        pending.deviceIdentityFingerprint
    ) {
      throw new TypeError('Pending device public key is invalid')
    }
    const approved = registry.approve(approval, approvalTime)
    const authentication = {
      deviceId: approved.deviceId,
      nodeId: approved.nodeId,
      credentialId: approved.credentialId,
    }
    await authority.registerCredential(authentication)
    await persistence.save(approvalTime)
    inventoryChanged()
    return authentication
  }
  const revoke = async (nodeId: string, revokedAt = now()): Promise<void> => {
    if (nodeId === options.localNodeInventory?.().nodeId) throw new TypeError('Main cannot remove itself')
    const node = registry.listNodes().find(node => node.nodeId === nodeId)
    if (!node) throw new TypeError('Device is not registered')
    const reason = 'Device removed by Main'
    if (node.state !== 'revoked') registry.revoke(node, reason, revokedAt)
    // Fail closed in memory, disconnect even if persistence fails, and allow retry.
    await Promise.all([persistence.save(revokedAt), nodeApi.closeNode(nodeId, reason)])
    inventoryChanged()
  }
  let stopping = false
  const stoppingGate: GatewayPlugin = (app) => {
    const rejectWhenStopping = async (
      context: Context,
      next: Next,
    ) => {
      if (stopping) {
        return context.json({ error: 'cluster_stopping' }, 503)
      }
      await next()
    }
    app.use('/pair/*', rejectWhenStopping)
    app.use('/cluster/*', rejectWhenStopping)
    app.use('/nodes/*', rejectWhenStopping)
  }

  return {
    registry,
    authority,
    plugins: [
      stoppingGate,
      pairingApiPlugin({
        service: pairing,
        authorizeOfferCreation: options.authorizeOfferCreation,
        clientKey: options.clientKey,
        now,
      }),
      deviceChallengeApiPlugin({
        authority,
        clientKey: options.clientKey,
        now,
      }),
      nodeAdministrationApiPlugin({
        registry,
        authorize: options.authorizeOfferCreation,
        approve,
        revoke,
        now,
      }),
      ...(options.localNodeInventory ? [nodeInventoryApiPlugin({
        path: '/nodes/v1',
        authorize: options.authorizeInventory ?? options.authorizeOfferCreation,
        inventory: getNodeInventory,
      })] : []),
      nodeApi.plugin,
    ],
    get activeSessionCount(): number {
      return nodeApi.activeSessionCount
    },
    remoteExecutor,
    workdirLookup,
    getNodeInventory,
    observeInventory(observer) {
      inventoryObservers.add(observer)
      return () => { inventoryObservers.delete(observer) }
    },
    approve,
    revoke,
    closeNodeConnections: (reason) => {
      stopping = true
      return nodeApi.closeAll(reason)
    },
    save: async (saveTime = now()) => {
      await persistence.save(saveTime)
      await persistence.flush()
    },
  }
}
