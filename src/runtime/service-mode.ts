import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'

export interface ServiceProcessIdentity {
  readonly electronVersion?: string
  readonly processType?: unknown
}

export function assertHeadlessServiceMode(
  env: Readonly<Record<string, string | undefined>>,
  identity: ServiceProcessIdentity = {
    electronVersion: process.versions.electron,
    processType: 'type' in process ? process.type : undefined,
  },
): void {
  if (identity.electronVersion && (env.ELECTRON_RUN_AS_NODE !== '1' || identity.processType !== undefined)) {
    throw new TypeError('Service mode requires Electron Node mode, not the Electron application entrypoint')
  }
  if (!env.WINDOWS_USE_LAUNCH_TOKEN?.trim()) {
    throw new TypeError('Service mode requires an authenticated local-control credential')
  }
  const port = Number(env.GATEWAY_PORT ?? env.SHADOW_LOOPBACK_PORT)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new TypeError('Service mode requires a fixed local-control port between 1 and 65535')
  }
  if (env.GATEWAY_HOST && !['127.0.0.1', '::1', 'localhost'].includes(env.GATEWAY_HOST)) {
    throw new TypeError('Service mode requires a loopback gateway host')
  }
}

export async function resolveServiceEnvironment(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<Readonly<Record<string, string | undefined>>> {
  const path = env.WINDOWS_USE_LAUNCH_TOKEN_FILE
  if (path === undefined) return env
  if (!args.includes('--service') || !['server', 'child'].includes(args[0] ?? '') || args[1] !== 'start') {
    throw new TypeError('A service credential file is only supported for server/child start --service')
  }
  if (env.WINDOWS_USE_LAUNCH_TOKEN !== undefined || env.GATEWAY_LAUNCH_CREDENTIAL !== undefined) {
    throw new TypeError('Service credential file and inline credentials cannot be combined')
  }
  if (!isAbsolute(path)) throw new TypeError('Service credential file must use an absolute path')
  let credential: string
  try {
    const handle = await open(path, 'r')
    try {
      const info = await handle.stat()
      if (!info.isFile() || info.size < 1 || info.size > 4096) throw new Error('Invalid credential file')
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) throw new Error('Invalid credential file')
      credential = bytes.subarray(0, bytesRead).toString('utf8').trim()
      if (!credential || /[\s\u0000-\u001f\u007f]/.test(credential)) throw new Error('Invalid credential file')
    } finally {
      await handle.close()
    }
  } catch {
    throw new Error('Unable to read a valid service credential file; check its contents and service account ACLs')
  }
  return { ...env, WINDOWS_USE_LAUNCH_TOKEN: credential }
}
