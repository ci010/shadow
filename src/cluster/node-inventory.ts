import type { CapabilityDescriptorV1 } from './contracts.ts'
import type { InMemoryPairingNodeRegistry } from './registry.ts'
import type { NodeWebSocketApi } from './node-websocket-api.ts'
import type { GatewayPlugin } from '../gateway/types.ts'
import { MANAGED_SESSION_CAPABILITY, MANAGED_SESSION_OPERATION } from '../execution/managed-workdir.ts'

export interface NodeInventoryResponse {
  readonly version: 1
  readonly nodes: readonly NodeInventoryEntry[]
}

export interface NodeInventoryEntry {
  readonly nodeId: string
  readonly displayName: string
  readonly role: 'main' | 'child'
  readonly connection: 'connected' | 'offline' | 'revoked'
  readonly capabilities: readonly NodeInventoryCapability[]
  readonly implementationVersion?: string
  readonly lastSeen?: string
  readonly supportsManagedSessions?: boolean
}

export interface NodeInventoryCapability {
  readonly capabilityId: string
  readonly kind: CapabilityDescriptorV1['kind']
  readonly displayName: string
  readonly online: boolean
  readonly displayPath?: string
}

export function inventoryCapability(
  capability: Pick<CapabilityDescriptorV1, 'capabilityId' | 'kind' | 'displayName' | 'online' | 'displayPath'>,
  connected: boolean,
): NodeInventoryCapability {
  return {
    capabilityId: capability.capabilityId,
    kind: capability.kind,
    displayName: capability.displayName,
    online: connected && capability.online,
    ...(capability.kind === 'workdir' && capability.displayPath !== undefined
      ? { displayPath: capability.displayPath } : {}),
  }
}

export function mainNodeInventory(
  localNode: NodeInventoryEntry | undefined,
  registry: InMemoryPairingNodeRegistry,
  connections: Pick<NodeWebSocketApi, 'isNodeConnected' | 'hasAdvertisedCapability'>,
): NodeInventoryResponse {
  return {
    version: 1,
    nodes: [
      ...(localNode ? [localNode] : []),
      ...registry.listNodes().map((node): NodeInventoryEntry => {
        const connection = node.state === 'revoked'
          ? 'revoked'
          : connections.isNodeConnected(node.nodeId) ? 'connected' : 'offline'
        return {
          nodeId: node.nodeId,
          displayName: node.displayName,
          role: 'child',
          connection,
          supportsManagedSessions: registry.listCapabilities(node.nodeId).some(capability =>
            capability.capabilityId === MANAGED_SESSION_CAPABILITY && capability.kind === 'shell' &&
            capability.online && capability.permissions.includes(MANAGED_SESSION_OPERATION) &&
            connection === 'connected' && connections.hasAdvertisedCapability(node.nodeId, capability.capabilityId)),
          // Persisted descriptors are not live until this connection advertises them.
          capabilities: registry.listCapabilities(node.nodeId).map((capability) =>
            inventoryCapability(
              capability,
              connection === 'connected' &&
                connections.hasAdvertisedCapability(node.nodeId, capability.capabilityId),
            )
          ),
        }
      }),
    ],
  }
}

export function nodeInventoryApiPlugin(options: {
  readonly path: '/nodes/v1' | '/local/v1/nodes'
  readonly authorize: (request: Request) => boolean | Promise<boolean>
  readonly inventory: () => NodeInventoryResponse | Promise<NodeInventoryResponse>
}): GatewayPlugin {
  return (app) => {
    app.get(options.path, async (context) => {
      if (!await options.authorize(context.req.raw)) {
        return context.json({ error: 'unauthorized' }, 401, {
          'Cache-Control': 'no-store',
          'WWW-Authenticate': 'Bearer',
        })
      }
      return context.json(await options.inventory(), 200, {
        'Cache-Control': 'no-store',
      })
    })
  }
}
