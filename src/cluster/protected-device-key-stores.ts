import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { getOs, isNotFoundError, type RuntimeOs } from '../utils/runtime.ts'
import type { ProtectedDeviceKeyStore } from './device-credentials.ts'

export type ProtectedKeyStoreErrorCode =
  | 'provider-unavailable'
  | 'protect-failed'
  | 'unprotect-failed'
  | 'store-failed'
  | 'lookup-failed'

export class ProtectedKeyStoreError extends Error {
  constructor(
    readonly code: ProtectedKeyStoreErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
    this.name = 'ProtectedKeyStoreError'
  }
}

interface CommandResult {
  readonly success: boolean
  readonly stdout: Uint8Array
}

export interface ProtectedKeyCommandRunner {
  run(
    command: string,
    args: readonly string[],
    input: Uint8Array,
    signal: AbortSignal,
  ): Promise<CommandResult>
}

export class NodeProtectedKeyCommandRunner
  implements ProtectedKeyCommandRunner {
  async run(
    command: string,
    args: readonly string[],
    input: Uint8Array,
    signal: AbortSignal,
  ): Promise<CommandResult> {
    signal.throwIfAborted()
    return await new Promise<CommandResult>((resolve, reject) => {
      const child = spawn(command, [...args], {
        stdio: ['pipe', 'pipe', 'ignore'],
        signal,
        windowsHide: true,
      })
      const chunks: Buffer[] = []
      child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
      child.stdin.on('error', () => { /* provider may exit before reading */ })
      child.once('error', (cause) => reject(
        signal.aborted ? signal.reason : new ProtectedKeyStoreError(
          'provider-unavailable',
          'Protected credential provider is unavailable',
          { cause },
        ),
      ))
      child.once('close', (code) => {
        if (signal.aborted) reject(signal.reason)
        else resolve({ success: code === 0, stdout: Buffer.concat(chunks) })
      })
      child.stdin.end(input)
    })
  }
}

const DPAPI_PROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$value=[Console]::In.ReadToEnd()',
  '$plain=[Convert]::FromBase64String($value)',
  '$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$cipher=[System.Security.Cryptography.ProtectedData]::Protect($plain,$null,$scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($cipher))',
].join(';')

const DPAPI_UNPROTECT_SCRIPT = [
  'Add-Type -AssemblyName System.Security',
  '$value=[Console]::In.ReadToEnd()',
  '$cipher=[Convert]::FromBase64String($value)',
  '$scope=[System.Security.Cryptography.DataProtectionScope]::CurrentUser',
  '$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($cipher,$null,$scope)',
  '[Console]::Out.Write([Convert]::ToBase64String($plain))',
].join(';')

export class WindowsDpapiDeviceKeyStore implements ProtectedDeviceKeyStore {
  constructor(
    readonly directory: string,
    readonly runner: ProtectedKeyCommandRunner =
      new NodeProtectedKeyCommandRunner(),
    readonly providerId = 'windows-dpapi-current-user',
  ) {}

  async load(keyId: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const filePath = this.#filePath(keyId)
    let protectedValue: Uint8Array
    try {
      protectedValue = await readFile(filePath)
    } catch (error) {
      if (isNotFoundError(error)) return null
      throw error
    }
    const result = await this.runner.run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_UNPROTECT_SCRIPT],
      protectedValue,
      signal,
    )
    if (!result.success) {
      throw new ProtectedKeyStoreError(
        'unprotect-failed',
        'Windows could not unlock the protected device credential',
      )
    }
    try {
      return decodeBase64(result.stdout)
    } catch (cause) {
      throw new ProtectedKeyStoreError(
        'unprotect-failed',
        'Windows returned invalid protected credential material',
        { cause },
      )
    }
  }

  async save(
    keyId: string,
    value: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.runner.run(
      'powershell.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', DPAPI_PROTECT_SCRIPT],
      new TextEncoder().encode(encodeBase64(value)),
      signal,
    )
    if (!result.success || result.stdout.length === 0) {
      throw new ProtectedKeyStoreError(
        'protect-failed',
        'Windows could not protect the device credential',
      )
    }
    await writeAtomic(this.#filePath(keyId), result.stdout)
  }

  #filePath(keyId: string): string {
    return join(this.directory, `${keyId}.dpapi`)
  }
}

export class LinuxSecretServiceDeviceKeyStore
  implements ProtectedDeviceKeyStore {
  readonly providerId = 'linux-secret-service'

  constructor(
    readonly applicationId = 'shadow',
    readonly runner: ProtectedKeyCommandRunner =
      new NodeProtectedKeyCommandRunner(),
  ) {}

  async load(keyId: string, signal: AbortSignal): Promise<Uint8Array | null> {
    const result = await this.runner.run(
      'secret-tool',
      ['lookup', 'application', this.applicationId, 'key-id', keyId],
      new Uint8Array(),
      signal,
    )
    if (!result.success) return null
    return trimTrailingNewline(result.stdout)
  }

  async save(
    keyId: string,
    value: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await this.runner.run(
      'secret-tool',
      [
        'store',
        '--label=Shadow device credential',
        'application',
        this.applicationId,
        'key-id',
        keyId,
      ],
      value,
      signal,
    )
    if (!result.success) {
      throw new ProtectedKeyStoreError(
        'store-failed',
        'Linux Secret Service could not store the device credential',
      )
    }
  }
}

export function createPlatformDeviceKeyStore(
  dataDirectory: string,
  os: RuntimeOs = getOs(),
  environment: Readonly<Record<string, string | undefined>> = process.env,
): ProtectedDeviceKeyStore {
  if (os === 'windows') {
    return new WindowsDpapiDeviceKeyStore(
      join(dataDirectory, 'credentials', 'protected'),
    )
  }
  if (os === 'linux' && (environment.WSL_INTEROP || environment.WSL_DISTRO_NAME)) {
    return new WindowsDpapiDeviceKeyStore(
      join(dataDirectory, 'credentials', 'protected'),
      new NodeProtectedKeyCommandRunner(),
      'wsl-windows-dpapi-current-user',
    )
  }
  if (os === 'linux') return new LinuxSecretServiceDeviceKeyStore()
  throw new ProtectedKeyStoreError(
    'provider-unavailable',
    `Protected device credentials are not supported on ${os}`,
  )
}

async function writeAtomic(filePath: string, value: Uint8Array): Promise<void> {
  const directory = dirname(filePath)
  await mkdir(directory, { recursive: true })
  const temporaryPath = join(directory, `.${crypto.randomUUID()}.tmp`)
  try {
    await writeFile(temporaryPath, value, {
      flag: 'wx',
      mode: 0o600,
    })
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath).catch((removeError) => {
      if (!isNotFoundError(removeError)) throw removeError
    })
    throw error
  }
}

function encodeBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function decodeBase64(value: Uint8Array): Uint8Array {
  const text = new TextDecoder('ascii', { fatal: true }).decode(value).trim()
  return Uint8Array.from(atob(text), (character) => character.charCodeAt(0))
}

function trimTrailingNewline(value: Uint8Array): Uint8Array {
  let end = value.length
  if (end > 0 && value[end - 1] === 10) end--
  if (end > 0 && value[end - 1] === 13) end--
  return value.slice(0, end)
}