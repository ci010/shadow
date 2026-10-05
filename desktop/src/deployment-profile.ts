import { lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, parse, resolve } from 'node:path'

export interface ManagedDeploymentProfile {
  version: 1
  role: 'main'
  userDataPath: string
}

export function parseManagedDeploymentProfile(value: unknown): ManagedDeploymentProfile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid managed deployment profile')
  const data = value as Record<string, unknown>
  if (Object.keys(data).length !== 3 || data.version !== 1 || data.role !== 'main'
    || typeof data.userDataPath !== 'string' || !isAbsolute(data.userDataPath)
    || parse(data.userDataPath).root === data.userDataPath || /[\u0000-\u001f]/u.test(data.userDataPath)) {
    throw new Error('Managed deployment requires a separate absolute Main profile path')
  }
  return { version: 1, role: 'main', userDataPath: data.userDataPath }
}

export function readManagedDeploymentProfile(
  resourcesPath: string, packaged: boolean, platform: NodeJS.Platform,
): ManagedDeploymentProfile | undefined {
  if (!packaged || platform !== 'darwin') return undefined
  // Deployment metadata stays outside the signed application, beside each immutable version.
  const path = join(resolve(resourcesPath, '..', '..', '..'), 'desktop-deployment.v1.json')
  let info
  try { info = lstatSync(path) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined
    throw error
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096
    || process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) {
    throw new Error('Managed deployment profile must be an owner-only regular file')
  }
  return parseManagedDeploymentProfile(JSON.parse(readFileSync(path, 'utf8')))
}
