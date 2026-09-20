import { createHash } from 'node:crypto'
import { constants, lstatSync, openSync, closeSync, readSync, fstatSync, readdirSync, unlinkSync, type Stats } from 'node:fs'
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path'
import type { SkillsManager } from '../skills/loader.ts'
import { parseSkillFile } from '../skills/parse.ts'
import { workspacePath } from '../utils/paths.ts'
import type { KnowledgeCatalog, KnowledgeDetail, KnowledgeEntry } from './contracts.ts'
import { extractLinks } from './links.ts'

export class KnowledgeError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: 400 | 403 | 404 | 409 | 413 | 422 | 503 = 400,
  ) { super(message) }
}

/** Fail explicitly rather than presenting an incomplete graph or delete preview. */
export const KNOWLEDGE_LIMITS = {
  entries: 10_000,
  links: 100_000,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 32 * 1024 * 1024,
  directories: 20_000,
  depth: 64,
} as const

function missing(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
}

function posixPath(path: string): string { return path.split(sep).join('/') }

export function validPath(id: string): boolean {
  return id.length > 0 && id.length <= 2048 && !/[\\:\0-\x1f<>|"*?]/.test(id)
    && id.split('/').every(part => !!part && !part.startsWith('.') && !/[. ]$/.test(part))
}

function memoryFile(id: string): boolean {
  return id.startsWith('memory/') && (
    id.endsWith('.md') || /^memory\/events\/[^/]+\.jsonl$/.test(id)
    || /^memory\/sessions\/[^/]+\.files\.jsonl$/.test(id)
  )
}

function checkId(id: unknown): asserts id is string {
  if (typeof id !== 'string') throw new KnowledgeError('invalid_knowledge_id', 'A canonical knowledge ID is required')
  if (id.startsWith('builtin:skills/')) {
    if (validPath(id.slice('builtin:'.length)) && id.split('/').length === 2) return
  } else if (validPath(id) && (memoryFile(id) || /^skills\/[^/]+\/SKILL\.md$/.test(id))) return
  throw new KnowledgeError('invalid_knowledge_id', 'Use a canonical memory file or skill ID')
}

/** Check from the filesystem root, not just the final file (Windows junctions included). */
export function safePath(path: string): Stats {
  const absolute = resolve(path)
  const root = parse(absolute).root
  const parts = relative(root, absolute).split(sep).filter(Boolean)
  let current = root
  let info = lstatSync(root)
  for (const part of parts) {
    if (!info.isDirectory()) throw new KnowledgeError('unsafe_knowledge_path', 'Knowledge ancestors must be directories', 403)
    current = join(current, part)
    info = lstatSync(current)
    if (info.isSymbolicLink()) throw new KnowledgeError('unsafe_knowledge_path', 'Linked knowledge paths are not accessible', 403)
  }
  return info
}

export function readSafe(path: string, maxBytes: number = KNOWLEDGE_LIMITS.fileBytes): { content: string; revision: string; bytes: Buffer } {
  const info = safePath(path)
  if (!info.isFile()) throw new KnowledgeError('unsafe_knowledge_path', 'Knowledge entries must be regular files', 403)
  if (info.size > maxBytes) throw new KnowledgeError('knowledge_limit', `Knowledge file exceeds the ${maxBytes} byte limit`, 413)
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new KnowledgeError('knowledge_changed', 'Knowledge file changed while opening it', 409)
    }
    const buffer = Buffer.alloc(64 * 1024)
    const chunks: Buffer[] = []
    let count = 0
    while (count <= maxBytes) {
      const read = readSync(descriptor, buffer, 0, Math.min(buffer.length, maxBytes + 1 - count), null)
      if (!read) break
      chunks.push(Buffer.from(buffer.subarray(0, read)))
      count += read
    }
    if (count > maxBytes) throw new KnowledgeError('knowledge_limit', `Knowledge file exceeds the ${maxBytes} byte limit`, 413)
    const bytes = Buffer.concat(chunks, count)
    return { content: bytes.toString('utf8'), revision: createHash('sha256').update(bytes).digest('hex'), bytes }
  } finally { closeSync(descriptor) }
}

function memoryKind(id: string): 'memory' | 'wiki' {
  return /^memory\/(?:sessions|events|conventions|working-sets)\//.test(id)
    || /(?:^|[/.])conventions\.md$/.test(id) ? 'memory' : 'wiki'
}

interface Record {
  detail: KnowledgeDetail
  file: string
  related?: string
}

export class KnowledgeService {
  private readonly workspace: string

  constructor(workspace: string, private readonly skills: SkillsManager) {
    this.workspace = workspacePath(workspace)
  }

  /** Bounded, detached source snapshot shared by browse and deterministic maintenance. */
  snapshot(): KnowledgeDetail[] {
    return this.records().map(record => record.detail).sort((a, b) => a.entry.id.localeCompare(b.entry.id))
  }

  catalog(): KnowledgeCatalog {
    const records = this.records()
    const skillIds = new Map(records.filter(record => record.detail.entry.kind === 'skill')
      .map(record => [record.detail.entry.title, record.detail.entry.id]))
    const links = new Map<string, KnowledgeCatalog['links'][number]>()
    for (const record of records) {
      let extracted: KnowledgeCatalog['links']
      try { extracted = extractLinks(record.detail, this.workspace, skillIds, record.related) }
      catch (error) {
        if (error instanceof SyntaxError) {
          throw new KnowledgeError('invalid_knowledge_content', `Invalid JSONL in ${record.detail.entry.id}; graph was not truncated`, 422)
        }
        throw error
      }
      for (const link of extracted) {
        links.set(JSON.stringify(link), link)
        if (links.size > KNOWLEDGE_LIMITS.links) throw new KnowledgeError('knowledge_limit', 'Knowledge graph exceeds 100,000 links', 413)
      }
    }
    return {
      entries: records.map(record => record.detail.entry).sort((a, b) => a.id.localeCompare(b.id)),
      links: [...links.values()],
    }
  }

  detail(id: unknown): KnowledgeDetail {
    return this.find(id).detail
  }

  delete(id: unknown, expectedRevision: unknown): { deleted: string } {
    checkId(id)
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      throw new KnowledgeError('invalid_knowledge_revision', 'A SHA-256 revision is required')
    }
    if (id.startsWith('builtin:')) throw new KnowledgeError('knowledge_readonly', 'Built-in skills cannot be deleted', 403)
    const record = this.find(id)
    // No await between the final path/content checks, unlink, and runtime invalidation.
    if (readSafe(record.file).revision !== expectedRevision) {
      throw new KnowledgeError('knowledge_changed', 'This entry changed; reload it before deleting', 409)
    }
    safePath(record.file)
    unlinkSync(record.file)
    if (record.detail.entry.kind === 'skill') this.skills.forgetSkillDirectory(dirname(record.file))
    return { deleted: id }
  }

  private find(id: unknown): Record {
    checkId(id)
    if (!id.startsWith('builtin:')) {
      try { safePath(workspacePath(this.workspace, ...id.split('/'))) }
      catch (error) {
        if (missing(error)) throw new KnowledgeError('knowledge_not_found', 'Knowledge entry not found', 404)
        throw error
      }
    }
    const record = this.records(id).find(record => record.detail.entry.id === id)
    if (!record) throw new KnowledgeError('knowledge_not_found', 'Knowledge entry not found', 404)
    return record
  }

  private records(only?: string): Record[] {
    const records: Record[] = []
    let bytes = 0
    const add = (file: string, entry: Omit<KnowledgeEntry, 'revision'>, related?: string) => {
      if (only && only !== entry.id) return
      const { content, revision } = readSafe(file)
      bytes += Buffer.byteLength(content)
      if (bytes > KNOWLEDGE_LIMITS.totalBytes || records.length >= KNOWLEDGE_LIMITS.entries) {
        throw new KnowledgeError('knowledge_limit', 'Knowledge catalog exceeds 10,000 entries or 32 MiB', 413)
      }
      if (entry.kind !== 'skill') {
        entry.title = /^#\s+(.+?)\s*#*\s*$/m.exec(content)?.[1] ?? basename(entry.path)
      } else {
        related = parseSkillFile(content, entry.title).learnedMeta?.related
      }
      records.push({ file, detail: { entry: { ...entry, revision }, content }, related })
    }
    if (!only || only.startsWith('memory/')) {
      if (only) {
        add(workspacePath(this.workspace, ...only.split('/')), {
          id: only, path: only, title: '', kind: memoryKind(only), source: 'project', deletable: true,
        })
      } else {
        const root = workspacePath(this.workspace, 'memory')
        let directories = 0
        const walk = (directory: string, depth: number) => {
          if (++directories > KNOWLEDGE_LIMITS.directories || depth > KNOWLEDGE_LIMITS.depth) {
            throw new KnowledgeError('knowledge_limit', 'Knowledge directory traversal limit exceeded', 413)
          }
          safePath(directory)
          for (const item of readdirSync(directory, { withFileTypes: true })) {
            if (item.name.startsWith('.') || item.isSymbolicLink()) continue
            const file = join(directory, item.name)
            const id = posixPath(relative(this.workspace, file))
            if (!validPath(id)) continue
            if (item.isDirectory()) walk(file, depth + 1)
            else if (item.isFile() && memoryFile(id)) {
              add(file, { id, path: id, title: '', kind: memoryKind(id), source: 'project', deletable: true })
            }
          }
        }
        let exists = true
        try { safePath(root) }
        catch (error) {
          if (missing(error)) exists = false
          else throw error
        }
        if (exists) walk(root, 0)
      }
    }
    if (!only || !only.startsWith('memory/')) {
      for (const { skill, source, shadowsBuiltin } of this.skills.availableSkillSources(true)) {
        const file = resolve(skill.dirPath, 'SKILL.md')
        const within = relative(this.workspace, file)
        const id = source === 'builtin' ? `builtin:skills/${skill.meta.name}` : posixPath(within)
        if (only && id !== only) continue
        if (source === 'project' && (isAbsolute(within) || !/^skills\/[^/]+\/SKILL\.md$/.test(id))) {
          throw new KnowledgeError('unsafe_knowledge_path', 'Project skills must remain in the project skills directory', 403)
        }
        checkId(id)
        const description = [skill.meta.description, shadowsBuiltin
          ? 'Deleting this project override restores the read-only built-in skill. Bundled resource files are retained.'
          : source === 'project' ? 'Deleting removes only SKILL.md; bundled resource files are retained.' : undefined]
          .filter(Boolean).join('\n\n')
        add(file, {
          id, path: id, kind: 'skill', title: skill.meta.name, source,
          deletable: source === 'project', description,
        })
      }
    }
    return records
  }
}
