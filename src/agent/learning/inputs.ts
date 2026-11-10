import { readdir, readFile, lstat } from 'node:fs/promises'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { fingerprint, type LearningLog } from './ledger.ts'

/** Discover knowledge already retained outside reflector receipts. No session,
 * identity, convention or internal-state scan. Revisions are consumed, not paths. */
export async function encapsulationInputs(workspace: string, signal: AbortSignal): Promise<LearningLog[]> {
  const inputs: LearningLog[] = []
  for (const directory of ['topics', 'concepts', 'tools', 'decisions', 'events']) {
    const root = projectStoragePath(workspace, 'memory', directory)
    let names: string[]
    try { names = await readdir(root) } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    for (const name of names.sort()) {
      signal.throwIfAborted()
      if (!name.endsWith(directory === 'events' ? '.jsonl' : '.md')) continue
      const file = `${root}/${name}`
      const stat = await lstat(file)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024) continue
      const content = await readFile(file, 'utf8')
      const path = `memory/${directory}/${name}`
      if (directory === 'events') {
        for (const line of content.split('\n').filter(Boolean)) {
          const log = JSON.parse(line) as Record<string, unknown>
          if (typeof log.what !== 'string' || typeof log.when !== 'string') continue
          inputs.push({ id: typeof log.id === 'string' ? log.id : fingerprint(`${path}:${line}`), path,
            origin: typeof log.origin === 'string' ? log.origin : `v:${path}`,
            when: log.when, who: typeof log.who === 'string' ? log.who : 'historical-log',
            what: log.what.slice(0, 8000),
            ...(typeof log.challenge === 'string' ? { challenge: log.challenge.slice(0, 8000) } : {}),
            ...(typeof log.why === 'string' ? { why: log.why.slice(0, 8000) } : {}),
            refs: [`v:${path}`, ...(Array.isArray(log.refs) ? log.refs.filter((ref): ref is string => typeof ref === 'string') : [])] })
        }
      } else if (content.trim()) {
        inputs.push({ id: fingerprint(`${path}:${content}`), path, origin: `v:${path}`,
          when: stat.mtime.toISOString(), who: 'knowledge-discovery',
          what: `Retained Wiki candidate: ${path}. Read the page before deciding whether its challenges or procedures merit encapsulation.`,
          refs: [`v:${path}`] })
      }
    }
  }
  return inputs
}
