import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'

const nameSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const valueSchema = z.string().min(1).max(16_384).regex(/^[^\u0000-\u001f\u007f]+$/)
const documentSchema = z.object({ version: z.literal(1), values: z.record(nameSchema, valueSchema) }).strict()

/** Host-only credentials; resource snapshots and coordinator tools receive names, never values. */
export class AgentCredentialStore {
  private readonly path: string
  private values: Record<string, string>

  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'credentials.json')
    try {
      this.values = documentSchema.parse(JSON.parse(readFileSync(this.path, 'utf8'))).values
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Could not load agent credentials; repair the credential store before starting.', { cause: error })
      this.values = {}
    }
  }

  names(): string[] { return Object.keys(this.values).sort() }

  resolve(name: string): string | undefined {
    nameSchema.parse(name)
    return Object.hasOwn(this.values, name) ? this.values[name] : undefined
  }

  put(name: string, value: string): void {
    nameSchema.parse(name)
    valueSchema.parse(value)
    const next = { ...this.values, [name]: value }
    writePrivateFile(this.path, JSON.stringify({ version: 1, values: next }))
    this.values = next
  }

  delete(name: string): void {
    nameSchema.parse(name)
    const next = { ...this.values }
    delete next[name]
    writePrivateFile(this.path, JSON.stringify({ version: 1, values: next }))
    this.values = next
  }
}
