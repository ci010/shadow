import { t } from './i18n.ts'
export class NodeOfflineError extends Error {
  constructor(readonly nodeId: string, readonly workdirId: string) {
    super(t('Node offline'))
    this.name = 'NodeOfflineError'
  }
}

/** Only the locality resolver's explicit node state establishes offline status. */
export function nodeOfflineError(status: number, value: unknown): NodeOfflineError | undefined {
  if (status !== 503 || !value || typeof value !== 'object' || Array.isArray(value)) return
  const data = value as Record<string, unknown>
  if ((data.error === 'workdir_unavailable' || data.error === 'remote_workdir_unavailable')
    && data.reason === 'node-offline'
    && data.capabilityId === undefined
    && typeof data.nodeId === 'string' && data.nodeId.trim()
    && typeof data.workdirId === 'string' && data.workdirId.trim()) {
    return new NodeOfflineError(data.nodeId, data.workdirId)
  }
}

export function isNodeOfflineError(error: unknown): error is NodeOfflineError {
  return error instanceof NodeOfflineError
}

export function workdirUnavailableMessage(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return
  const data = value as Record<string, unknown>
  if (data.error === 'execution-upgrade-required' || data.code === 'execution-upgrade-required') {
    return t('This device uses an incompatible execution protocol. Update Main and the device, then retry. No local folder was used.')
  }
  if (data.error !== 'workdir_unavailable' && data.error !== 'remote_workdir_unavailable') return
  switch (data.reason) {
    case 'workdir-revoked': return t('Access to this folder resource was revoked. Select an authorized project folder.')
    case 'workdir-missing': return t('This folder resource is no longer available on the owning device.')
    case 'workdir-offline': return t('The folder resource is unavailable on the owning device. Restore the folder and check again.')
    case 'incompatible': return t('This device uses an incompatible execution protocol. Update Main and the device, then retry. No local folder was used.')
    case 'node-missing': return t('The owning node is no longer registered. Select an available node and folder.')
  }
}
