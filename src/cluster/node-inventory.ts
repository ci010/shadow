import type { ExecutionSupport, WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import type { InMemoryPairingNodeRegistry } from './registry.ts'
import type { NodeWebSocketApi } from './node-websocket-api.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { MANAGED_SESSION_OPERATION } from '../execution/managed-workdir.ts'

export interface NodeInventoryResponse { readonly version: 1; readonly nodes: readonly NodeInventoryEntry[] }
export interface NodeInventoryEntry {
  readonly nodeId: string
  readonly displayName: string
  readonly role: 'main' | 'child'
  readonly connection: 'connected' | 'offline' | 'revoked'
  readonly executionProtocol: 'compatible' | 'upgrade-required' | 'unknown'
  readonly workdirs: readonly WorkdirAdvertisement[]
  readonly support: ExecutionSupport
  readonly implementationVersion?: string
  readonly lastSeen?: string
  readonly supportsManagedSessions?: boolean
}
export function inventoryWorkdir(workdir: WorkdirAdvertisement, connected: boolean): WorkdirAdvertisement {
  return { ...structuredClone(workdir), online: connected && workdir.online }
}
export function mainNodeInventory(localNode: NodeInventoryEntry | undefined, registry: InMemoryPairingNodeRegistry,
  connections: Pick<NodeWebSocketApi, 'isNodeConnected' | 'hasAdvertisedNodeSupport' | 'hasAdvertisedWorkdir' | 'supportsExecutionProtocol'>): NodeInventoryResponse {
  return { version: 1, nodes: [
    ...(localNode ? [localNode] : []),
    ...registry.listNodes().map((node): NodeInventoryEntry => {
      const connection = node.state === 'revoked' ? 'revoked' : connections.isNodeConnected(node.nodeId) ? 'connected' : 'offline'
      const protocol = connection !== 'connected' ? 'unknown' : connections.supportsExecutionProtocol(node.nodeId) ? 'compatible' : 'upgrade-required'
      const live = protocol === 'compatible'
      const support = live && connections.hasAdvertisedNodeSupport(node.nodeId) ? registry.nodeSupport(node.nodeId) : { operations: [] }
      return { nodeId: node.nodeId, displayName: node.displayName, role: 'child', connection, executionProtocol: protocol,
        supportsManagedSessions: support.operations.includes(MANAGED_SESSION_OPERATION), support,
        workdirs: registry.listWorkdirs(node.nodeId).map(workdir => inventoryWorkdir(workdir, live && connections.hasAdvertisedWorkdir(node.nodeId, workdir.workdirId))) }
    }),
  ] }
}

export function nodeInventoryApiPlugin(options: {
  readonly path: '/nodes/v1' | '/local/v1/nodes'
  readonly authorize: (request: Request) => boolean | Promise<boolean>
  readonly inventory: () => NodeInventoryResponse | Promise<NodeInventoryResponse>
}): GatewayPlugin {
  return (app) => {
    app.get(options.path, async (context) => {
      if (!await options.authorize(context.req.raw)) {
        return context.json({ error: 'unauthorized' }, 401, { 'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer' })
      }
      return context.json(await options.inventory(), 200, { 'Cache-Control': 'no-store' })
    })
  }
}
