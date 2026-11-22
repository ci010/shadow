import { isExecutionIdentifier } from './workdir-contracts.ts'

/** Reserved Child-side binding, never a Project folder or a persisted session cwd. */
export const DEVICE_HOME_WORKDIR = 'device-home-v1'
export const DEVICE_HOME_SHELL_OPERATIONS = ['workdir.process.execute-once', 'workdir.process.reconcile']
export const DEVICE_HOME_OPERATIONS = ['filesystem.read', ...DEVICE_HOME_SHELL_OPERATIONS]

export function deviceHomeNode(selector: string): string {
  const nodeId = selector.slice('device:'.length)
  if (!selector.startsWith('device:') || !isExecutionIdentifier(nodeId) || nodeId === 'local') {
    throw new Error('Use device:<exact Child nodeId>. No Main fallback is allowed.')
  }
  return nodeId
}

/** Map the alias to a relative path inside the Child's actual home binding. */
export function deviceHomeArgs<T>(request: T & { workdirId?: string; args: unknown }): T {
  if (request.workdirId !== DEVICE_HOME_WORKDIR || !request.args || typeof request.args !== 'object' || Array.isArray(request.args)) return request
  const args = { ...request.args } as Record<string, unknown>
  for (const key of ['path', 'cwd']) {
    const value = args[key]
    if (typeof value !== 'string') continue
    if (value === '~') args[key] = '.'
    else if (/^~[\\/]/.test(value)) args[key] = `.${value.slice(1)}`
  }
  return { ...request, args }
}
