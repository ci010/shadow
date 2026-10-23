import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { SafegitRunner } from './safegit.ts'

const verified = new Set<string>()
/** Child-only PATH, never global shell configuration. Native names work in
 * noninteractive shells and nested processes, including Windows .exe lookup. */
export async function localExecSafegitAliasEnv(
  env: Record<string, string>, sessionDataDir: string, host: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, string>> {
  let directory: string
  let failure: string | undefined
  try {
    const binary = env.SHADOW_SAFEGIT_PATH
    if (!binary || !isAbsolute(binary)) throw new Error('Pinned safegit is missing or SHADOW_SAFEGIT_PATH is not absolute')
    const bytes = await readFile(binary)
    const digest = createHash('sha256').update(bytes).digest('hex')
    directory = join(sessionDataDir, 'cli', 'safegit', digest)
    const alias = join(directory, process.platform === 'win32' ? 'safegit.exe' : 'safegit')
    await mkdir(directory, { recursive: true })
    // Content-addressed copies support arbitrary override names and filesystems
    // without symlink privileges. Unchanged binaries are never copied again.
    try { await writeFile(alias, bytes, { flag: 'wx', mode: 0o755 }) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      if (!bytes.equals(await readFile(alias))) throw new Error('Corrupt safegit alias cache')
    }
    await chmod(alias, 0o755)
    if (!verified.has(alias)) {
      const status = await new SafegitRunner(() => alias).status()
      if (!status.supported) throw new Error(status.reason)
      verified.add(alias)
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
    directory = join(sessionDataDir, 'cli', 'safegit', 'unavailable')
    await mkdir(directory, { recursive: true })
    // An existing invalid .exe stops native Windows lookup before any later
    // system executable. POSIX shells get a nonzero, explanatory blocker.
    await writeFile(join(directory, 'safegit.exe'), 'Unavailable pinned safegit; inspect SHADOW_SAFEGIT_ERROR.\n')
    await writeFile(join(directory, 'safegit'), '#!/bin/sh\necho "Pinned safegit unavailable; inspect SHADOW_SAFEGIT_ERROR. No automatic fallback." >&2\nexit 127\n', { mode: 0o755 })
    await chmod(join(directory, 'safegit'), 0o755)
  }
  const configuredPath = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1]
  // Node selects the first lexicographic key when Windows env contains both
  // PATH and Path. Canonical uppercase wins even after merging process.env.
  const pathKey = process.platform === 'win32' ? 'PATH'
    : Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
  const inherited = configuredPath ?? Object.entries(host).find(([key]) => key.toLowerCase() === 'path')?.[1] ?? ''
  return { ...env, [pathKey]: `${directory}${delimiter}${inherited}`,
    ...(failure ? { SHADOW_SAFEGIT_ERROR: failure } : {}) }
}
