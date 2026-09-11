import type { CapabilityDescriptorV1 } from './contracts.ts'
import type { InMemoryPairingNodeRegistry } from './registry.ts'
import type { NodeWebSocketApi } from './node-websocket-api.ts'
import type { GatewayPlugin } from '../gateway/types.ts'

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
}

export interface NodeInventoryCapability {
  readonly capabilityId: string
  readonly kind: CapabilityDescriptorV1['kind']
  readonly displayName: string
  readonly online: boolean
  readonly displayPath?: string
}

export function inventoryCapability(
  capability: Pick<CapabilityDescriptorV1, 'capabilityId' | 'kind' | 'displayName' | 'online'>,
  connected: boolean,
): NodeInventoryCapability {
  return {
    capabilityId: capability.capabilityId,
    kind: capability.kind,
    displayName: capability.displayName,
    online: connected && capability.online,
  }
}

export function mainNodeInventory(
  localNode: NodeInventoryEntry,
  registry: InMemoryPairingNodeRegistry,
  connections: Pick<NodeWebSocketApi, 'isNodeConnected' | 'hasAdvertisedCapability'>,
): NodeInventoryResponse {
  return {
    version: 1,
    nodes: [
      localNode,
      ...registry.listNodes().map((node): NodeInventoryEntry => {
        const connection = node.state === 'revoked'
          ? 'revoked'
          : connections.isNodeConnected(node.nodeId) ? 'connected' : 'offline'
        return {
          nodeId: node.nodeId,
          displayName: node.displayName,
          role: 'child',
          connection,
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
