import type { NodeInventoryCapability, NodeInventoryEntry, NodeInventoryResponse } from '../../src/cluster/node-inventory.ts'
import { isRecord } from './projects-sidebar.ts'
import { apiUrl, hostBase } from './api-url.ts'

export type { NodeInventoryEntry }

export const CAPABILITY_LABELS: Record<NodeInventoryCapability['kind'], string> = {
  workdir: 'Workdir',
  shell: 'Shell',
  browser: 'Browser',
  'windows-ui': 'Desktop control',
  gpu: 'GPU',
}

export function capabilitySummary(capabilities: readonly NodeInventoryCapability[]): string {
  const counts = new Map<NodeInventoryCapability['kind'], number>()
  for (const capability of capabilities) counts.set(capability.kind, (counts.get(capability.kind) ?? 0) + 1)
  return Array.from(counts, ([kind, count]) => `${CAPABILITY_LABELS[kind]} (${count})`).join(' · ')
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

function isCapabilityKind(value: unknown): value is NodeInventoryCapability['kind'] {
  return typeof value === 'string' && Object.hasOwn(CAPABILITY_LABELS, value)
}

export function parseNodeInventory(value: unknown): NodeInventoryResponse {
  const invalid = () => new Error('The backend returned invalid device data. Update Shadow and retry.')
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.nodes)) throw invalid()
  const nodeIds = new Set<string>()
  const nodes: NodeInventoryEntry[] = value.nodes.map((node: unknown) => {
    if (!isRecord(node) || !nonempty(node.nodeId) || nodeIds.has(node.nodeId)
      || !nonempty(node.displayName) || (node.role !== 'main' && node.role !== 'child')
      || (node.connection !== 'connected' && node.connection !== 'offline' && node.connection !== 'revoked')
      || !Array.isArray(node.capabilities)
      || (node.implementationVersion !== undefined && !nonempty(node.implementationVersion))
      || (node.lastSeen !== undefined && (!nonempty(node.lastSeen) || !Number.isFinite(Date.parse(node.lastSeen))))) throw invalid()
    nodeIds.add(node.nodeId)
    const ids = new Set<string>()
    const capabilities: NodeInventoryCapability[] = node.capabilities.map((capability: unknown) => {
      if (!isRecord(capability) || !nonempty(capability.capabilityId) || ids.has(capability.capabilityId)
        || !isCapabilityKind(capability.kind) || !nonempty(capability.displayName)
        || typeof capability.online !== 'boolean'
        || (capability.displayPath !== undefined && !nonempty(capability.displayPath))) throw invalid()
      ids.add(capability.capabilityId)
      return {
        capabilityId: capability.capabilityId, kind: capability.kind,
        displayName: capability.displayName, online: capability.online,
        ...(capability.displayPath === undefined ? {} : { displayPath: capability.displayPath }),
      }
    })
    return {
      nodeId: node.nodeId, displayName: node.displayName, role: node.role,
      connection: node.connection, capabilities,
      ...(node.implementationVersion === undefined ? {} : { implementationVersion: node.implementationVersion }),
      ...(node.lastSeen === undefined ? {} : { lastSeen: node.lastSeen }),
    }
  })
  return { version: 1, nodes }
}

export async function fetchNodeInventory(
  apiBase: string,
  mode: 'main' | 'child',
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<NodeInventoryResponse> {
  const response = await request(apiUrl(hostBase(apiBase), mode === 'child' ? '/local/v1/nodes' : '/nodes/v1'), {
    signal, cache: 'no-store',
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error('Device access was denied. Open Nodes through the authorized desktop app or reconnect.')
  }
  if (response.status === 404 || response.status === 501) {
    throw new Error('This backend does not provide device inventory. Restart Shadow after updating the backend.')
  }
  if (!response.ok) throw new Error(`Could not load devices (${response.status}). Check the backend and retry.`)
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error('This backend did not return device inventory. Restart Shadow after updating the backend.')
  }
  let data: unknown
  try {
    data = await response.json()
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error('The backend returned invalid device data. Update Shadow and retry.')
    throw cause
  }
  return parseNodeInventory(data)
}

export function capabilityAvailability(node: NodeInventoryEntry, capability: NodeInventoryCapability): 'online' | 'unavailable' | 'revoked' {
  if (node.connection === 'revoked') return 'revoked'
  return node.connection === 'connected' && capability.online ? 'online' : 'unavailable'
}
