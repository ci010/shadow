import { BootstrapCoordinator } from '../bootstrap/coordinator.js'
import { FileRuntimeConfigReader } from '../bootstrap/runtime-config.js'
import type { RuntimeHost } from '../sidecar/runtime-host.js'
import type { ServiceConnectionDescriptor } from './connection.js'

/** Attach never reads or rewrites the desktop's sidecar profile or Home. */
export function createServiceBootstrapCoordinator(
  descriptor: ServiceConnectionDescriptor,
  host: RuntimeHost,
): BootstrapCoordinator {
  const rejectMutation = async (): Promise<never> => {
    throw new Error('Service attachment is read-only; manage the service with the administrator lifecycle commands')
  }
  return new BootstrapCoordinator(
    {
      load: async () => ({ version: 1, revision: 0, mode: 'main', step: 'complete' }),
      save: rejectMutation,
      clear: rejectMutation,
    },
    { writeMain: rejectMutation },
    { initialize: rejectMutation },
    host,
    {
      load: async () => ({ version: 1, role: 'main', port: descriptor.port, localExecutor: false }),
      save: rejectMutation,
    },
    new FileRuntimeConfigReader(descriptor.configPath),
  )
}
