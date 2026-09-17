import type {
  SidecarReadinessProbe, SidecarStartRequest, SidecarStatus, SidecarSupervisor,
} from '../sidecar/supervisor.js'
import type { ServiceConnection } from './connection.js'

/** SCM owns this process. Stopping the desktop host only revokes its attachment. */
export class ServiceAttachmentSupervisor implements SidecarSupervisor {
  status: SidecarStatus = { phase: 'stopped' }
  private detached = false

  constructor(
    private readonly connection: ServiceConnection,
    private readonly readinessProbe: SidecarReadinessProbe,
  ) {}

  async start(request: SidecarStartRequest): Promise<SidecarStatus> {
    const { descriptor, launchToken } = this.connection
    if (request.role !== descriptor.role || request.port !== descriptor.port
      || request.localExecutor === true || request.launchToken !== launchToken) {
      throw new Error('Service attachment does not match the requested runtime configuration')
    }
    if (this.detached) throw new Error('Service attachment has been closed')
    this.status = { phase: 'starting', role: descriptor.role }
    try {
      const readiness = await this.readinessProbe(descriptor.apiBase, launchToken)
      if (this.detached) throw new Error('Service attachment has been closed')
      if (!readiness.ready || readiness.failure) {
        throw new Error('Service is unavailable or its readiness contract does not match')
      }
      this.status = { phase: 'ready', role: descriptor.role, apiBase: descriptor.apiBase }
      return this.status
    } catch {
      this.status = this.detached ? { phase: 'stopped' } : {
        phase: 'failed', role: descriptor.role, kind: 'configuration-error',
        message: 'Service is unavailable or its readiness contract does not match; no local runtime was launched',
      }
      throw new Error('Service attachment failed; check the installed service, connection descriptor, and credential')
    }
  }

  async stop(): Promise<void> {
    this.detached = true
    this.status = { phase: 'stopped' }
  }
}
