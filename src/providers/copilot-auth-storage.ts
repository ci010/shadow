import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { protectedSecretStore, type ProtectedSecretStore } from '../utils/protected-secret.ts'
import { writePrivateFile } from '../utils/private-file.ts'
import type { CopilotAuthStorage } from './copilot.ts'

const prefix = 'shadow-copilot-aes-gcm-v1:'

/** Values stay synchronous so config commit/undo and auth epochs remain atomic to the event loop. */
export function createCopilotAuthStorage(directory: string,
  secrets: ProtectedSecretStore = protectedSecretStore(directory)): CopilotAuthStorage {
  const root = resolve(directory)
  const metadata = join(root, 'active-host')
  const marker = join(root, '.protected-key-created')
  const lock = join(root, '.protected-key-lock')
  function readFile(file: string): string | undefined {
    try { return readFileSync(file, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
  function write(file: string, value: string) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
    writePrivateFile(file, value)
  }
  function key(create: boolean): Buffer {
    mkdirSync(root, { recursive: true, mode: 0o700 })
    // Fail closed on concurrent initialization rather than overwrite another process's key.
    mkdirSync(lock, { mode: 0o700 })
    try {
      let value = secrets.load()
      if (!value) {
        if (!create || existsSync(marker)) throw new Error('Protected Copilot master key is missing')
        value = randomBytes(32)
        try { secrets.save(value) } catch (error) { value.fill(0); throw error }
      }
      if (value.length !== 32) { value.fill(0); throw new Error('Invalid Copilot master key') }
      if (!existsSync(marker)) write(marker, 'v1\n')
      return value
    } finally { rmSync(lock, { recursive: true }) }
  }
  function aad(name: string) { return Buffer.from(`shadow/copilot/v1\0${root}\0${resolve(name)}`) }
  function decrypt(name: string, raw: string): string {
    if (!raw.startsWith(prefix)) throw new Error('Invalid protected Copilot credential')
    const bytes = Buffer.from(raw.slice(prefix.length), 'base64')
    if (bytes.length < 28) throw new Error('Invalid protected Copilot credential')
    const master = key(false)
    try {
      const decipher = createDecipheriv('aes-256-gcm', master, bytes.subarray(0, 12))
      decipher.setAAD(aad(name))
      decipher.setAuthTag(bytes.subarray(12, 28))
      return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
    } finally { master.fill(0) }
  }
  function encrypt(name: string, value: string) {
    const master = key(true)
    try {
      const nonce = randomBytes(12)
      const cipher = createCipheriv('aes-256-gcm', master, nonce)
      cipher.setAAD(aad(name))
      const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
      write(`${name}.protected`, prefix + Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString('base64'))
    } finally { master.fill(0) }
  }
  return {
    read(name) {
      if (resolve(name) === metadata) return readFile(name) // Host selection is not a credential; startup stays OS-provider-free.
      const encrypted = readFile(`${name}.protected`)
      if (encrypted !== undefined) {
        const value = decrypt(name, encrypted)
        // Retry an interrupted migration's cleanup, and do not use credentials if deletion fails.
        rmSync(name, { force: true })
        return value
      }
      const legacy = readFile(name)
      if (legacy === undefined) return undefined
      encrypt(name, legacy)
      const verified = decrypt(name, readFileSync(`${name}.protected`, 'utf8'))
      if (verified !== legacy) throw new Error('Copilot credential migration verification failed')
      rmSync(name, { force: true })
      return verified
    },
    write(name, value) {
      if (resolve(name) === metadata) { write(name, value); return }
      encrypt(name, value)
      if (decrypt(name, readFileSync(`${name}.protected`, 'utf8')) !== value) throw new Error('Copilot credential write verification failed')
      rmSync(name, { force: true })
    },
    remove(name) {
      // Remove legacy first: a partial failure must never reactivate a plaintext copy.
      rmSync(name, { force: true })
      rmSync(`${name}.protected`, { force: true })
    },
  }
}
