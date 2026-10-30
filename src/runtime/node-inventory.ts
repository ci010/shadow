import { hostname } from 'node:os'
import { stat } from 'node:fs/promises'
import type { ExecutionSupport, WorkdirAdvertisement } from '../execution/workdir-contracts.ts'
import { MANAGED_SESSION_OPERATION } from '../execution/managed-workdir.ts'
import {
  inventoryWorkdir,
  type NodeInventoryEntry,
} from '../cluster/node-inventory.ts'
import type { FolderRegistry } from '../folders/registry.ts'
import { localFolderWorkdirRef } from '../sessions/locality.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import {
  type GatewayClientAddressRegistry,
  isLoopbackGatewayRequest,
  validateLaunchCredential,
} from '../gateway/server.ts'

export function authorizeMainNodeInventory(
  request: Request,
  launchCredential: string | undefined,
  clientAddresses: GatewayClientAddressRegistry,
): boolean | Promise<boolean> {
  if (launchCredential) {
    return validateLaunchCredential(
      request.headers.get('Authorization') ?? undefined,
      launchCredential,
    )
  }
  return isLoopbackGatewayRequest(request, clientAddresses)
}

export function mainLocalNodeInventory(options: {
  readonly localNodeId: string
  readonly implementationVersion: string
  readonly folders: Pick<FolderRegistry, 'list' | 'lookupWorkdir'>
  readonly shellAvailable: boolean
}): NodeInventoryEntry {
  return {
    nodeId: options.localNodeId,
    displayName: hostname(),
    role: 'main',
    connection: 'connected',
    implementationVersion: options.implementationVersion,
    executionProtocol: 'compatible',
    support: { operations: options.shellAvailable ? ['process.execute'] : [] },
    workdirs: options.folders.list().filter(folder => folder.kind !== 'remote').map(folder => {
      const ref = localFolderWorkdirRef(folder.id)
      return { version: 2, nodeId: options.localNodeId, workdirId: ref.workdirId, displayName: folder.name,
        support: { operations: ['filesystem.read', 'filesystem.write', 'workdir.git.status', 'workdir.git.diff', 'workdir.identity', ...(options.shellAvailable ? ['workdir.process.execute'] : [])] },
        displayPath: folder.path, online: options.folders.lookupWorkdir(ref)?.workdir?.online === true }
    }),
  }
}

export async function childLocalNodeInventory(
  config: ChildBootstrapConfigV1,
  workdirs: readonly WorkdirAdvertisement[],
  support: ExecutionSupport,
  implementationVersion: string,
  connection: 'connected' | 'offline' = 'connected',
): Promise<NodeInventoryEntry> {
  return {
    nodeId: config.localNodeId,
    displayName: hostname(),
    role: 'child',
    connection,
    executionProtocol: connection === 'connected' ? 'compatible' : 'unknown',
    supportsManagedSessions: connection === 'connected' && support.operations.includes(MANAGED_SESSION_OPERATION),
    implementationVersion,
    support: connection === 'connected' ? structuredClone(support) : { operations: [] },
    workdirs: await Promise.all(workdirs.map(async workdir => {
      const projected = inventoryWorkdir(workdir, connection === 'connected')
      const binding = config.workdirs?.find(value => value.workdirId === workdir.workdirId)
      if (!binding) return projected
      return { ...projected, displayPath: binding.rootPath, online: projected.online && await directoryAvailable(binding.rootPath) }
    })),
  }
}

async function directoryAvailable(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch (error) {
    if (
      ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(
        (error as NodeJS.ErrnoException).code ?? '',
      )
    ) return false
    throw error
  }
}
