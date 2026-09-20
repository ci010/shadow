import { hostname } from 'node:os'
import { stat } from 'node:fs/promises'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import { MANAGED_SESSION_CAPABILITY, MANAGED_SESSION_OPERATION } from '../execution/managed-workdir.ts'
import {
  inventoryCapability,
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
    capabilities: [
      ...(options.shellAvailable ? [{
        capabilityId: 'process-execute',
        kind: 'shell' as const,
        displayName: 'Local shell',
        online: true,
      }] : []),
      ...options.folders.list().filter(folder => folder.kind !== 'remote').map((folder) => {
        const ref = localFolderWorkdirRef(folder.id)
        return {
          capabilityId: ref.capabilityId,
          kind: 'workdir' as const,
          displayName: folder.name,
          displayPath: folder.path,
          online: options.folders.lookupWorkdir(ref)?.capability?.online === true,
        }
      }),
    ],
  }
}

export async function childLocalNodeInventory(
  config: ChildBootstrapConfigV1,
  capabilities: readonly CapabilityDescriptorV1[],
  implementationVersion: string,
): Promise<NodeInventoryEntry> {
  return {
    nodeId: config.localNodeId,
    displayName: hostname(),
    role: 'child',
    connection: 'connected',
    supportsManagedSessions: capabilities.some(capability => capability.capabilityId === MANAGED_SESSION_CAPABILITY &&
      capability.kind === 'shell' && capability.online && capability.permissions.includes(MANAGED_SESSION_OPERATION)),
    implementationVersion,
    capabilities: await Promise.all(capabilities.map(async (capability) => {
      const projected = inventoryCapability(capability, true)
      const workdir = capability.kind === 'workdir'
        ? config.workdirs?.find((value) => value.capabilityId === capability.capabilityId)
        : undefined
      if (!workdir) return projected
      return {
        ...projected,
        displayPath: workdir.rootPath,
        online: projected.online && await directoryAvailable(workdir.rootPath),
      }
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
