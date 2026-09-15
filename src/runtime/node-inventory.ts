import { hostname } from 'node:os'
import { stat } from 'node:fs/promises'
import type { CapabilityDescriptorV1 } from '../cluster/contracts.ts'
import {
  inventoryCapability,
  type NodeInventoryEntry,
} from '../cluster/node-inventory.ts'
import type { ProjectRegistry } from '../projects/registry.ts'
import { localProjectWorkdirRef } from '../sessions/locality.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import {
  type GatewayClientAddressRegistry,
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
  const hostname = new URL(request.url).hostname
  if (!['localhost', '127.0.0.1', '[::1]'].includes(hostname)) return false
  return ['tcp:127.0.0.1', 'tcp:::1', 'tcp:::ffff:127.0.0.1'].includes(
    clientAddresses.resolve(request),
  )
}

export function mainLocalNodeInventory(options: {
  readonly localNodeId: string
  readonly implementationVersion: string
  readonly projects: Pick<ProjectRegistry, 'list' | 'lookupWorkdir'>
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
      ...options.projects.list().filter(project => project.kind !== 'remote').map((project) => {
        const ref = localProjectWorkdirRef(project.id)
        return {
          capabilityId: ref.capabilityId,
          kind: 'workdir' as const,
          displayName: project.name,
          displayPath: project.path,
          online: options.projects.lookupWorkdir(ref)?.capability?.online === true,
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
