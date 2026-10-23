import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { normalizeLoopbackOrigin } from '../runtime-authorization.js'

export const SERVICE_NAME = 'ShadowService'

export interface ServiceConnectionDescriptor {
  readonly version: 1
  readonly serviceName: typeof SERVICE_NAME
  readonly role: 'main'
  readonly apiBase: string
  readonly port: number
  readonly credentialPath: string
  readonly configPath: string
}

export interface ServiceConnection {
  readonly descriptor: ServiceConnectionDescriptor
  readonly launchToken: string
}

function absolutePath(value: unknown): value is string {
  return typeof value === 'string' && isAbsolute(value)
    && (process.platform !== 'win32' || /^[A-Za-z]:\\/u.test(value))
    && !/[\u0000-\u001f]/u.test(value)
}

export function parseServiceConnectionDescriptor(value: unknown): ServiceConnectionDescriptor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Service connection descriptor is invalid')
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).length !== 7
    || candidate.version !== 1 || candidate.serviceName !== SERVICE_NAME
    || candidate.role !== 'main'
    || typeof candidate.apiBase !== 'string'
    || normalizeLoopbackOrigin(candidate.apiBase) !== candidate.apiBase
    || !Number.isSafeInteger(candidate.port)
    || (candidate.port as number) < 1 || (candidate.port as number) > 65535
    || Number(new URL(candidate.apiBase).port || '80') !== candidate.port
    || !absolutePath(candidate.credentialPath) || !absolutePath(candidate.configPath)) {
    throw new TypeError('Service connection descriptor is invalid')
  }
  return candidate as unknown as ServiceConnectionDescriptor
}

export function selectServiceConnectionPath(
  switchValue: string | undefined,
  environmentValue: string | undefined,
): string | undefined {
  if (switchValue !== undefined && environmentValue !== undefined && switchValue !== environmentValue) {
    throw new TypeError('Conflicting service connection selections')
  }
  const selected = switchValue ?? environmentValue
  if (selected !== undefined && !absolutePath(selected)) {
    throw new TypeError('Service connection requires an explicit absolute descriptor path')
  }
  return selected
}

export async function loadServiceConnection(
  path: string,
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<ServiceConnection> {
  if (!absolutePath(path)) throw new TypeError('Service connection path must be absolute')
  try {
    const descriptor = parseServiceConnectionDescriptor(JSON.parse(await read(path)))
    const launchToken = (await read(descriptor.credentialPath)).trim()
    if (!/^[A-Za-z0-9_-]{43,256}$/u.test(launchToken)) {
      throw new TypeError('Invalid service credential')
    }
    return { descriptor, launchToken }
  } catch {
    // Never echo JSON, filesystem contents, or a credential in startup errors.
    throw new Error('Service connection or credential could not be loaded; check installation and access permissions')
  }
}
