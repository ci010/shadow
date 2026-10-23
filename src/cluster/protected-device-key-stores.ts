import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { createHash, timingSafeEqual } from 'node:crypto'
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
  readonly exitCode?: number | null
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
        else resolve({
          success: code === 0,
          stdout: Buffer.concat(chunks),
          exitCode: code,
        })
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

/**
 * Uses the current user's default Keychain; it must already be unlocked and
 * accessible to /usr/bin/security. Never unlocks it or weakens item access.
 */
export class MacOsKeychainDeviceKeyStore implements ProtectedDeviceKeyStore {
  readonly providerId = 'macos-keychain'

  constructor(
    readonly service = 'shadow.device-credentials',
    readonly runner: ProtectedKeyCommandRunner =
      new NodeProtectedKeyCommandRunner(),
  ) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(service)) {
      throw new TypeError('Keychain service must be a safe application identifier')
    }
  }

  async load(keyId: string, signal: AbortSignal): Promise<Uint8Array | null> {
    signal.throwIfAborted()
    const result = await this.runner.run(
      '/usr/bin/security',
      ['find-generic-password', '-s', this.service, '-a', this.#account(keyId), '-w'],
      new Uint8Array(),
      signal,
    )
    signal.throwIfAborted()
    // security returns OSStatus modulo 256: errSecItemNotFound (-25300).
    // Denied, locked, unavailable, and unknown failures are not missing keys.
    if (!result.success && result.exitCode === 44) return null
    if (!result.success) {
      throw new ProtectedKeyStoreError(
        'lookup-failed',
        'macOS Keychain could not read the device credential; ensure the user Keychain is unlocked and accessible',
      )
    }
    try {
      const encoded = trimTrailingNewline(result.stdout)
      const decoded = decodeBase64(encoded)
      if (!Buffer.from(encoded).equals(Buffer.from(encodeBase64(decoded)))) {
        throw new Error('Noncanonical encoding')
      }
      return decoded
    } catch {
      throw new ProtectedKeyStoreError(
        'unprotect-failed',
        'macOS Keychain returned invalid device credential material',
      )
    }
  }

  async save(
    keyId: string,
    value: Uint8Array,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted()
    // Keep the interactive command below security's fixed-size input buffer.
    if (value.length > 2048) {
      throw new ProtectedKeyStoreError(
        'store-failed',
        'macOS Keychain device credential exceeds the supported size',
      )
    }
    const expected = new Uint8Array(value)
    // Only fixed tokens, a validated service, a digest, and base64 enter this
    // parser. No key material enters process arguments or a shell command.
    const input = Buffer.from(
      `add-generic-password -U -s ${this.service} -a ${this.#account(keyId)} -w "${encodeBase64(expected)}"\n`,
    )
    try {
      const result = await this.runner.run(
        '/usr/bin/security',
        ['-i'],
        input,
        signal,
      )
      signal.throwIfAborted()
      if (!result.success) {
        throw new ProtectedKeyStoreError(
          'store-failed',
          'macOS Keychain could not store the device credential; ensure the user Keychain is unlocked and accessible',
        )
      }
      // Interactive security versions may return success for failed commands.
      // A fresh lookup is mandatory before publishing a credential reference.
      const stored = await this.load(keyId, signal)
      if (
        stored === null || stored.length !== expected.length ||
        !timingSafeEqual(stored, expected)
      ) {
        throw new ProtectedKeyStoreError(
          'store-failed',
          'macOS Keychain did not persist the device credential',
        )
      }
    } finally {
      input.fill(0)
      expected.fill(0)
    }
  }

  #account(keyId: string): string {
    return createHash('sha256').update(keyId, 'utf8').digest('hex')
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
  if (os === 'darwin') return new MacOsKeychainDeviceKeyStore()
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