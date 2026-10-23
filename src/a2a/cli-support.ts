import { mkdirSync, openSync, closeSync, unlinkSync, writeFileSync } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'

export const absolutePath = z.string().min(1).refine(isAbsolute, 'An absolute local path is required.')

export async function readA2aConfig(): Promise<unknown | undefined> {
  const { values } = parseArgs({ options: { config: { type: 'string' }, help: { type: 'boolean', short: 'h' } }, strict: true })
  if (values.help) {
    console.error('Usage: --config <absolute JSON configuration path>. See docs/a2a.md.')
    return undefined
  }
  const path = absolutePath.parse(values.config)
  if ((await stat(path)).size > 64 * 1024) throw new Error('A2A configuration exceeds 64 KiB.')
  return JSON.parse(await readFile(path, 'utf8'))
}

/** Never steal a possibly live journal; stale locks require an operator check. */
export function lockA2aDirectory(directory: string): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const path = join(directory, '.lock')
  const file = openSync(path, 'wx', 0o600)
  try { writeFileSync(file, JSON.stringify({ pid: process.pid }) + '\n') }
  finally { closeSync(file) }
  return () => unlinkSync(path)
}
