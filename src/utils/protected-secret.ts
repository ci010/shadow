import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { writePrivateFile } from './private-file.ts'

/** Synchronous counterpart for synchronous credential transactions. No shell or secret argv. */
export interface SecretCommandResult { status: number | null; stdout: Buffer; stderr: Buffer; error?: Error }
export type SecretCommand = (command: string, args: string[], input: Buffer) => SecretCommandResult
const command: SecretCommand = (file, args, input) => spawnSync(file, args, {
  input, windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024,
})

export interface ProtectedSecretStore {
  load(): Buffer | undefined
  save(value: Buffer): void
}

/** Current OS user only. Never unlocks a keychain or substitutes a machine-wide scope. */
export function protectedSecretStore(directory: string, run: SecretCommand = command,
  platform: NodeJS.Platform = process.platform): ProtectedSecretStore {
  const id = createHash('sha256').update(resolve(directory)).digest('hex')
  const service = 'shadow.copilot-master-key'
  const file = join(directory, 'master-key.dpapi')
  const invoke = (exe: string, args: string[], input: Buffer = Buffer.alloc(0)) => {
    const result = run(exe, args, input)
    if (result.error || result.status === null) throw new Error('OS credential provider unavailable')
    return result
  }
  const decode = (value: Buffer) => {
    const text = value.toString('utf8').trimEnd()
    const result = Buffer.from(text, 'base64')
    if (result.length !== 32 || result.toString('base64') !== text) throw new Error('Invalid protected master key')
    return result
  }
  const dpapi = (operation: 'Protect' | 'Unprotect', input: Buffer) => {
    const script = `Add-Type -AssemblyName System.Security;$ErrorActionPreference='Stop';$v=[Convert]::FromBase64String([Console]::In.ReadToEnd());$r=[System.Security.Cryptography.ProtectedData]::${operation}($v,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($r))`
    const result = invoke('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], input)
    if (result.status !== 0 || !result.stdout.length) throw new Error('Windows user credential protection failed')
    return result.stdout
  }
  const windows = platform === 'win32' || (platform === 'linux' && !!(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME))
  const store: ProtectedSecretStore = {
    load() {
      if (windows) {
        let value: Buffer
        try { value = readFileSync(file) } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
          throw error
        }
        return decode(dpapi('Unprotect', value))
      }
      if (platform === 'darwin') {
        const result = invoke('/usr/bin/security', ['find-generic-password', '-s', service, '-a', id, '-w'])
        if (result.status === 44) return undefined
        if (result.status !== 0) throw new Error('macOS Keychain unavailable or locked')
        return decode(result.stdout)
      }
      if (platform === 'linux') {
        const result = invoke('secret-tool', ['lookup', 'application', service, 'key-id', id])
        if (result.status === 1 && !result.stderr.length) return undefined
        if (result.status !== 0) throw new Error('Linux Secret Service unavailable or locked')
        return decode(result.stdout)
      }
      throw new Error('No supported OS credential provider')
    },
    save(value) {
      if (value.length !== 32) throw new Error('Invalid master key length')
      const encoded = Buffer.from(value.toString('base64'))
      try {
        if (windows) {
          const encrypted = dpapi('Protect', encoded)
          mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
          writePrivateFile(file, encrypted.toString('utf8'))
        } else if (platform === 'darwin') {
          const input = Buffer.from(`add-generic-password -U -s ${service} -a ${id} -w "${encoded.toString()}"\n`)
          try {
            if (invoke('/usr/bin/security', ['-i'], input).status !== 0) throw new Error('macOS Keychain write failed')
          } finally { input.fill(0) }
        } else if (platform === 'linux') {
          if (invoke('secret-tool', ['store', '--label=Shadow Copilot master key', 'application', service, 'key-id', id], encoded).status !== 0) throw new Error('Linux Secret Service write failed')
        } else throw new Error('No supported OS credential provider')
        const loaded = store.load()
        if (!loaded || !loaded.equals(value)) throw new Error('OS credential write verification failed')
        loaded.fill(0)
      } finally { encoded.fill(0) }
    },
  }
  return store
}
