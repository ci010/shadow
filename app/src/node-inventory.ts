import { t } from './i18n.ts'
import type { NodeInventoryEntry, NodeInventoryResponse } from '../../src/cluster/node-inventory.ts'
import { validateExecutionSupport, validateWorkdirAdvertisement, type WorkdirAdvertisement } from '../../src/execution/workdir-contracts.ts'
import { isRecord } from './folders-sidebar.ts'
import { apiUrl, hostBase } from './api-url.ts'

export type { NodeInventoryEntry }

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function parseNodeInventory(value: unknown): NodeInventoryResponse {
  const invalid = () => new Error(t('The backend returned invalid device data. Update Shadow and retry.'))
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.nodes)) throw invalid()
  const nodeIds = new Set<string>()
  const nodes: NodeInventoryEntry[] = value.nodes.map((node: unknown) => {
    if (!isRecord(node) || !nonempty(node.nodeId) || nodeIds.has(node.nodeId)
      || !nonempty(node.displayName) || (node.role !== 'main' && node.role !== 'child')
      || (node.connection !== 'connected' && node.connection !== 'offline' && node.connection !== 'revoked')) throw invalid()
    if (node.executionProtocol === undefined || !Array.isArray(node.workdirs)) {
      throw new Error(t('This device uses an incompatible execution protocol. Update Main and the device, then retry. No local folder was used.'))
    }
    if ((node.executionProtocol !== 'compatible' && node.executionProtocol !== 'upgrade-required' && node.executionProtocol !== 'unknown')
      || Object.hasOwn(node, 'capabilities') || Object.hasOwn(node, 'resources')
      || (node.supportsManagedSessions !== undefined && typeof node.supportsManagedSessions !== 'boolean')
      || (node.implementationVersion !== undefined && !nonempty(node.implementationVersion))
      || (node.lastSeen !== undefined && (!nonempty(node.lastSeen) || !Number.isFinite(Date.parse(node.lastSeen))))) throw invalid()
    nodeIds.add(node.nodeId)
    const workdirIds = new Set<string>()
    const workdirs: WorkdirAdvertisement[] = node.workdirs.map((value: unknown) => {
      const result = validateWorkdirAdvertisement(value)
      if (!result.success || result.value.nodeId !== node.nodeId || workdirIds.has(result.value.workdirId)) throw invalid()
      workdirIds.add(result.value.workdirId)
      return result.value
    })
    const support = validateExecutionSupport(node.support, 'node')
    if (!support.success) throw invalid()
    return {
      nodeId: node.nodeId, displayName: node.displayName, role: node.role,
      connection: node.connection, executionProtocol: node.executionProtocol, workdirs, support: support.value,
      ...(node.supportsManagedSessions === undefined ? {} : { supportsManagedSessions: node.supportsManagedSessions }),
      ...(node.implementationVersion === undefined ? {} : { implementationVersion: node.implementationVersion }),
      ...(node.lastSeen === undefined ? {} : { lastSeen: node.lastSeen }),
    }
  })
  return { version: 1, nodes }
}

export async function fetchNodeInventory(
  apiBase: string,
  mode: 'main' | 'child' | 'client',
  signal: AbortSignal,
  request: typeof fetch = fetch,
): Promise<NodeInventoryResponse> {
  if (mode === 'client') throw new Error(t('Device administration is not available to mobile clients.'))
  const response = await request(apiUrl(hostBase(apiBase), mode === 'child' ? '/local/v1/nodes' : '/nodes/v1'), {
    signal, cache: 'no-store',
  })
  if (response.status === 401 || response.status === 403) {
    throw new Error(t('Device access was denied. Open Nodes through the authorized desktop app or reconnect.'))
  }
  if (response.status === 404 || response.status === 501) {
    throw new Error(t('This backend does not provide device inventory. Restart Shadow after updating the backend.'))
  }
  if (!response.ok) throw new Error(t('Could not load devices ({status}). Check the backend and retry.', { status: response.status }))
  if (response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    throw new Error(t('This backend did not return device inventory. Restart Shadow after updating the backend.'))
  }
  let data: unknown
  try {
    data = await response.json()
  } catch (cause) {
    if (cause instanceof SyntaxError) throw new Error(t('The backend returned invalid device data. Update Shadow and retry.'))
    throw cause
  }
  return parseNodeInventory(data)
}

export function workdirAvailability(node: NodeInventoryEntry, workdir: WorkdirAdvertisement): 'online' | 'unavailable' | 'revoked' {
  if (node.connection === 'revoked') return 'revoked'
  return node.executionProtocol === 'compatible' && node.connection === 'connected'
    && workdir.nodeId === node.nodeId && workdir.online ? 'online' : 'unavailable'
}

/** Availability hint only; the backend still checks current Project access. */
export function workdirSupportsOperations(node: NodeInventoryEntry, workdirId: string): boolean {
  return node.workdirs.some(workdir => workdir.workdirId === workdirId && workdir.support.operations.length > 0 && workdirAvailability(node, workdir) === 'online')
}
