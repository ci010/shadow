import nativePath from 'node:path'
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

/** Interpret absolute paths on the Child, not on the Main OS. The filesystem
 * handler still checks realpath containment (including symlinks/junctions). */
export function deviceHomeReadArgs<T extends { workdirId?: string; args: unknown }>(request: T, root: string, paths = nativePath): T {
  const { isAbsolute, parse, relative } = paths
  const normalized = deviceHomeArgs<T>(request)
  if (request.workdirId !== DEVICE_HOME_WORKDIR || !normalized.args || typeof normalized.args !== 'object') return normalized
  const args = normalized.args as Record<string, unknown>
  const path = args.path
  if (typeof path !== 'string' || !isAbsolute(path)) return normalized
  const childRelative = relative(root, path)
  if ((paths === nativePath.win32 && parse(path).root.length === 1) || isAbsolute(childRelative) || /^\.\.(?:[\\/]|$)/.test(childRelative)) {
    throw new Error('Absolute path is outside the Child home or is not fully qualified.')
  }
  return { ...normalized, args: { ...args, path: childRelative || '.' } }
}
