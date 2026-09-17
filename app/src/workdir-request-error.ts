export class NodeOfflineError extends Error {
  constructor(readonly nodeId: string, readonly capabilityId: string) {
    super('Node offline')
    this.name = 'NodeOfflineError'
  }
}

/** Only the locality resolver's explicit node state establishes offline status. */
export function nodeOfflineError(status: number, value: unknown): NodeOfflineError | undefined {
  if (status !== 503 || !value || typeof value !== 'object' || Array.isArray(value)) return
  const data = value as Record<string, unknown>
  if ((data.error === 'workdir_unavailable' || data.error === 'remote_workdir_unavailable')
    && data.reason === 'node-offline'
    && typeof data.nodeId === 'string' && data.nodeId.trim()
    && typeof data.capabilityId === 'string' && data.capabilityId.trim()) {
    return new NodeOfflineError(data.nodeId, data.capabilityId)
  }
}

export function isNodeOfflineError(error: unknown): error is NodeOfflineError {
  return error instanceof NodeOfflineError
}

export function workdirUnavailableMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const data = value as Record<string, unknown>
  if (data.error !== 'workdir_unavailable' && data.error !== 'remote_workdir_unavailable') return
  switch (data.reason) {
    case 'capability-revoked': return 'Access to this workdir was revoked. Select an available folder capability.'
    case 'capability-missing': return 'This folder capability is no longer available on the owning node.'
    case 'capability-offline': return 'The folder capability is unavailable on the owning node. Restore the folder and check again.'
    case 'incompatible': return 'This workdir capability is incompatible. Update the owning node or select another folder.'
    case 'node-missing': return 'The owning node is no longer registered. Select an available node and folder.'
  }
}
