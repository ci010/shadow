import { projectStoragePath } from '../utils/data-paths.ts'
import fs from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv-provider.js'
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation/types.js'
import type { Skill, SkillsManager } from './loader.ts'
import { parseSkillFile } from './parse.ts'
import { getArch, getOs } from '../utils/runtime.ts'

/** Limits apply to the complete package, not just the submitted edit. */
export const SKILL_EDIT_LIMITS = Object.freeze({
  files: 256,
  entries: 512,
  bytes: 8 * 1024 * 1024,
  depth: 16,
  pathLength: 512,
  componentLength: 120,
})

export interface SkillEditSnapshot {
  name: string
  revision: string | null
  files: Record<string, Buffer>
  source: 'project' | 'builtin' | 'missing'
}

export interface SkillEditResult {
  name: string
  revision: string
  files: string[]
}

interface PackageSnapshot {
  files: Record<string, Buffer>
  directories: Set<string>
  revision: string
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === 'ENOENT'
}

function info(path: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(path)
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

function component(value: string): void {
  if (!value || value === '.' || value === '..' ||
    value.length > SKILL_EDIT_LIMITS.componentLength ||
    value !== value.normalize('NFC') || value !== value.trim() ||
    /[<>:"/\\|?*\x00-\x1f\x7f]/.test(value) || /[. ]$/.test(value) || /~[0-9]/.test(value) ||
    /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³]|CONIN\$|CONOUT\$) *(?:\.|$)/i.test(value)) {
    throw new TypeError(`Unsafe skill path component: ${JSON.stringify(value)}`)
  }
}

function skillName(name: string): void {
  if (typeof name !== 'string') throw new TypeError('Skill name must be a string')
  component(name)
  if (name.startsWith('.')) throw new TypeError('Skill names must not start with a dot')
}

function resourcePath(value: string): string {
  if (typeof value !== 'string' || value.length > SKILL_EDIT_LIMITS.pathLength) {
    throw new TypeError('Skill resource path exceeds the path length limit')
  }
  const parts = value.replaceAll('\\', '/').split('/')
  if (parts.length > SKILL_EDIT_LIMITS.depth) throw new TypeError('Skill resource path exceeds the depth limit')
  for (const part of parts) component(part)
  return parts.join('/')
}

function assertDirectory(path: string): boolean {
  const stat = info(path)
  if (!stat) return false
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new TypeError(`Skill path must be a directory without symlinks or junctions: ${path}`)
  }
  return true
}

/** Also check the owning workspace and its ancestors, not just package children. */
function assertAncestors(path: string): boolean {
  const parent = dirname(path)
  if (parent !== path && !assertAncestors(parent)) return false
  return assertDirectory(path)
}

function sameFile(left: fs.Stats, right: fs.Stats): boolean {
  // Windows can update ctime on open without a content change.
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs
}

function revision(files: Record<string, Buffer>, directories: Set<string>): string {
  const hash = createHash('sha256')
  for (const path of [...directories].sort()) hash.update(`D${Buffer.byteLength(path)}:${path}`)
  for (const path of Object.keys(files).sort()) {
    const content = files[path]!
    hash.update(`F${Buffer.byteLength(path)}:${path}:${content.length}:`).update(content)
  }
  return hash.digest('hex')
}

function checkLayout(files: Record<string, Buffer>, directories: Set<string>): void {
  const paths = new Map<string, { path: string; directory: boolean }>()
  let bytes = 0
  const add = (path: string, directory: boolean) => {
    resourcePath(path)
    const key = path.toUpperCase()
    const previous = paths.get(key)
    if (previous && (previous.path !== path || previous.directory !== directory)) {
      throw new TypeError(`Skill path collision: ${previous.path} and ${path}`)
    }
    paths.set(key, { path, directory })
    if (paths.size > SKILL_EDIT_LIMITS.entries) throw new TypeError('Skill package exceeds the entry limit')
  }
  for (const path of directories) add(path, true)
  const names = Object.keys(files)
  if (names.length > SKILL_EDIT_LIMITS.files) throw new TypeError('Skill package exceeds the file count limit')
  for (const path of names) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) {
      const directory = parts.slice(0, i).join('/')
      add(directory, true)
      directories.add(directory)
    }
    add(path, false)
    bytes += files[path]!.length
    if (bytes > SKILL_EDIT_LIMITS.bytes) throw new TypeError('Skill package exceeds the byte limit')
  }
}

function capture(directory: string): PackageSnapshot | undefined {
  if (!assertAncestors(directory)) return undefined
  const files: Record<string, Buffer> = Object.create(null)
  const directories = new Set<string>()
  let bytes = 0
  let entries = 0
  const walk = (parent: string, prefix: string) => {
    const before = fs.lstatSync(parent)
    if (before.isSymbolicLink() || !before.isDirectory()) throw new TypeError('Skill directory changed during read')
    const handle = fs.opendirSync(parent)
    try {
      for (let entry = handle.readSync(); entry; entry = handle.readSync()) {
        if (++entries > SKILL_EDIT_LIMITS.entries) throw new TypeError('Skill package exceeds the entry limit')
        const path = resourcePath(prefix ? `${prefix}/${entry.name}` : entry.name)
        const absolute = join(directory, ...path.split('/'))
        const stat = fs.lstatSync(absolute)
        if (stat.isSymbolicLink()) throw new TypeError(`Skill packages must not contain symlinks or junctions: ${path}`)
        if (stat.isDirectory()) {
          directories.add(path)
          walk(absolute, path)
        } else {
          if (!stat.isFile() || stat.nlink > 1) throw new TypeError(`Skill resource must be an unlinked regular file: ${path}`)
          if (Object.keys(files).length >= SKILL_EDIT_LIMITS.files) throw new TypeError('Skill package exceeds the file count limit')
          if (stat.size > SKILL_EDIT_LIMITS.bytes - bytes) throw new TypeError('Skill package exceeds the byte limit')
          const descriptor = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0))
          try {
            if (!sameFile(stat, fs.fstatSync(descriptor))) throw new Error('Skill resource changed during read')
            // Read no more than the checked size plus one, even if an external writer grows it.
            const buffer = Buffer.alloc(stat.size + 1)
            let length = 0
            while (length < buffer.length) {
              const count = fs.readSync(descriptor, buffer, length, buffer.length - length, null)
              if (!count) break
              length += count
            }
            if (length !== stat.size || !sameFile(stat, fs.fstatSync(descriptor)) ||
              !sameFile(stat, fs.lstatSync(absolute))) throw new Error('Skill resource changed during read')
            files[path] = buffer.subarray(0, length)
            bytes += length
          } finally {
            fs.closeSync(descriptor)
          }
        }
      }
    } finally {
      handle.closeSync()
    }
    if (!sameFile(before, fs.lstatSync(parent))) throw new Error('Skill directory changed during read')
  }
  walk(directory, '')
  checkLayout(files, directories)
  return { files, directories, revision: revision(files, directories) }
}

function snapshot(directory: string): PackageSnapshot | undefined {
  const first = capture(directory)
  const second = capture(directory)
  if (first?.revision !== second?.revision) throw new Error('Skill package changed during read; retry')
  return second
}

function packageRevision(packageSnapshot: PackageSnapshot | undefined): string | null {
  return packageSnapshot && Object.keys(packageSnapshot.files).length ? packageSnapshot.revision : null
}

/** Internal runtime freshness check; fingerprints are not model-facing content. */
export function readSkillDirectory(directory: string): { revision: string; files: Record<string, Buffer> } {
  const current = snapshot(resolve(directory))
  if (!current?.files['SKILL.md']) throw new Error(`Skill package is missing SKILL.md: ${directory}`)
  return { revision: current.revision, files: current.files }
}

function parseCandidate(name: string, files: Record<string, Buffer>, directory: string): Skill {
  const manifest = files['SKILL.md']
  if (!manifest) throw new TypeError('Skill package must contain SKILL.md')
  const text = new TextDecoder('utf-8', { fatal: true }).decode(manifest)
  if (!text.trim()) throw new TypeError('SKILL.md must not be empty')
  const normalized = text.replace(/\r\n/g, '\n')
  if (/^---(?:\s|$)/.test(normalized)) {
    const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) throw new TypeError('SKILL.md has malformed YAML frontmatter delimiters')
    const document = parseDocument(match[1], { uniqueKeys: true })
    if (document.errors.length) throw new TypeError(`Invalid SKILL.md YAML: ${document.errors.map(error => error.message).join('; ')}`)
    const frontmatter: unknown = document.toJS({ maxAliasCount: 100 })
    if (!frontmatter || typeof frontmatter !== 'object' || Array.isArray(frontmatter)) {
      throw new TypeError('SKILL.md frontmatter must be a YAML mapping')
    }
    const declaredName = (frontmatter as Record<string, unknown>).name
    if (declaredName !== undefined && declaredName !== name) throw new TypeError('Skill frontmatter name must match its directory')
  }
  const parsed = parseSkillFile(text, name)
  if (parsed.meta.name !== name) throw new TypeError('Skill frontmatter name must match its directory')
  if (parsed.meta.toolsError) throw new TypeError(`Invalid skill tools: ${parsed.meta.toolsError}`)
  for (const [toolName, tool] of Object.entries(parsed.meta.tools ?? {})) {
    const source = resourcePath(tool.source.replace(/^\.([/\\])/, ''))
    if (!Object.hasOwn(files, source)) throw new TypeError(`Skill tool "${toolName}" source does not exist: ${source}`)
    try {
      new AjvJsonSchemaValidator().getValidator(tool.parameters as JsonSchemaType)
    } catch (error) {
      throw new TypeError(`Invalid parameter schema for skill tool "${toolName}": ${String(error)}`)
    }
  }
  return { ...parsed, dirPath: directory, isLearned: parsed.learnedMeta !== undefined }
}

function assertVisible(snapshot: PackageSnapshot | undefined, name: string, admin: boolean): void {
  if (!admin && snapshot?.files['SKILL.md']) {
    const { meta } = parseSkillFile(snapshot.files['SKILL.md'].toString('utf8'), name)
    if (meta.admin) throw new Error(`Skill "${name}" requires an admin session`)
  }
}

/**
 * Ordinary shared Skill package editing. No history, deployment or session state.
 * Synchronous bounded snapshots and a per-store queue prevent JS interleaving.
 * Renames support rollback, not power-loss durability or an OS-level sandbox:
 * unrelated processes may observe the brief replacement gap or race filesystem checks.
 */
export class SkillEditStore {
  private readonly root: string
  private queue: Promise<void> = Promise.resolve()

  constructor(workspace: string, private readonly skills: SkillsManager) {
    this.root = projectStoragePath(workspace, 'skills')
    if (this.root !== resolve(skills.loadPaths().workspaceDir)) {
      throw new TypeError('SkillEditStore and SkillsManager must use the same workspace')
    }
  }

  private target(name: string): string {
    skillName(name)
    if (assertAncestors(this.root)) {
      const directory = fs.opendirSync(this.root)
      try {
        for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
          if (entry.name.toUpperCase() === name.toUpperCase() && entry.name !== name) {
            throw new TypeError(`Skill name collides with existing directory: ${entry.name}`)
          }
        }
      } finally {
        directory.closeSync()
      }
    }
    return join(this.root, name)
  }

  read(name: string, admin = false): SkillEditSnapshot {
    const current = snapshot(this.target(name))
    assertVisible(current, name, admin)
    if (packageRevision(current)) return { name, revision: current!.revision, files: current!.files, source: 'project' }
    const builtin = this.skills.availableSkillSources(true).find(entry => entry.source === 'builtin' && entry.skill.meta.name === name)
    if (!builtin) return { name, revision: null, files: Object.create(null), source: 'missing' }
    if (builtin.skill.meta.admin && !admin) throw new Error(`Skill "${name}" requires an admin session`)
    const packaged = snapshot(builtin.skill.dirPath)
    if (!packaged) throw new Error(`Builtin skill "${name}" package is missing`)
    return { name, revision: packaged.revision, files: packaged.files, source: 'builtin' }
  }

  async save(
    name: string,
    edits: Record<string, string | null>,
    expectedRevision: string | null,
    admin = false,
    signal?: AbortSignal,
  ): Promise<SkillEditResult> {
    signal?.throwIfAborted()
    skillName(name)
    if (expectedRevision !== null && (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision))) {
      throw new TypeError('Expected skill revision must be a SHA-256 fingerprint or null')
    }
    if (!edits || typeof edits !== 'object' || Array.isArray(edits)) throw new TypeError('Skill edits must be a file-to-text/null object')
    const changes: Record<string, Buffer | null> = Object.create(null)
    const editNames = new Set<string>()
    let editBytes = 0
    for (const [rawPath, value] of Object.entries(edits)) {
      const path = resourcePath(rawPath)
      const key = path.toUpperCase()
      if (editNames.has(key)) throw new TypeError(`Duplicate or case-colliding skill edit: ${rawPath}`)
      editNames.add(key)
      if (editNames.size > SKILL_EDIT_LIMITS.files) throw new TypeError('Skill edit exceeds the file count limit')
      if (value !== null && typeof value !== 'string') throw new TypeError('Skill edit values must be UTF-8 strings or null')
      editBytes += value === null ? 0 : Buffer.byteLength(value)
      if (editBytes > SKILL_EDIT_LIMITS.bytes) throw new TypeError('Skill edit exceeds the byte limit')
      changes[path] = value === null ? null : Buffer.from(value, 'utf8')
    }
    const result = this.queue.then(() => this.commit(name, changes, expectedRevision, admin, signal))
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  private commit(
    name: string,
    changes: Record<string, Buffer | null>,
    expectedRevision: string | null,
    admin: boolean,
    signal?: AbortSignal,
  ): SkillEditResult {
    signal?.throwIfAborted()
    const target = this.target(name)
    const original = snapshot(target)
    assertVisible(original, name, admin)
    if (!original?.files['SKILL.md'] && this.skills.availableSkillSources(true).some(entry =>
      (entry.source === 'builtin' || entry.shadowsBuiltin) && entry.skill.meta.name.toUpperCase() === name.toUpperCase())) {
      throw new Error('Builtin-only skills cannot be edited; choose a new skill name')
    }
    if (packageRevision(original) !== expectedRevision) throw new Error('Skill revision conflict; read the current package before saving')
    const files = Object.assign(Object.create(null) as Record<string, Buffer>, original?.files)
    const directories = new Set(original?.directories)
    for (const [path, content] of Object.entries(changes)) {
      const existing = Object.keys(files).find(key => key.toUpperCase() === path.toUpperCase())
      if (existing && existing !== path) throw new TypeError(`Skill edit path has different casing: ${path}`)
      if (content === null) delete files[path]
      else files[path] = content
    }
    checkLayout(files, directories)
    const skill = parseCandidate(name, files, target)
    if (skill.meta.admin && !admin) throw new Error('Creating or editing an admin skill requires an admin session')
    const nextRevision = revision(files, directories)
    signal?.throwIfAborted()
    // Validation is complete before any persistent directory is touched.
    if (!assertAncestors(this.root)) {
      const config = dirname(this.root)
      if (!assertAncestors(config)) {
        if (!assertAncestors(dirname(config))) throw new Error('Skill workspace must already exist')
        fs.mkdirSync(config)
      }
      fs.mkdirSync(this.root)
    }
    const transaction = join(this.root, `.skill-edit-${randomUUID()}`)
    const staged = join(transaction, 'candidate')
    const previous = join(transaction, 'previous')
    let movedOriginal = false
    let installed = false
    let failure: unknown
    let failed = false
    fs.mkdirSync(transaction)
    try {
      fs.mkdirSync(staged)
      for (const directory of [...directories].sort((a, b) => a.split('/').length - b.split('/').length)) {
        fs.mkdirSync(join(staged, ...directory.split('/')), { recursive: true })
      }
      for (const [path, content] of Object.entries(files)) {
        fs.writeFileSync(join(staged, ...path.split('/')), content, { flag: 'wx' })
      }
      signal?.throwIfAborted()
      this.target(name)
      const latest = snapshot(target)
      if (packageRevision(latest) !== expectedRevision || latest?.revision !== original?.revision) {
        throw new Error('Skill revision conflict during commit')
      }
      const prepared = snapshot(staged)
      if (prepared?.revision !== nextRevision) throw new Error('Staged skill package changed during commit')
      signal?.throwIfAborted()
      // Intentionally no await between the final check, both renames and manager refresh.
      if (original) {
        fs.renameSync(target, previous)
        movedOriginal = true
      }
      try {
        fs.renameSync(staged, target)
      } catch (error) {
        if (movedOriginal) {
          try {
            fs.renameSync(previous, target)
            movedOriginal = false
          } catch (rollbackError) {
            throw new AggregateError([error, rollbackError], `Skill replacement and rollback failed; original retained at ${previous}`)
          }
        }
        throw error
      }
      installed = true
      this.skills.forgetSkillDirectory(target)
      if ((!skill.meta.platform?.length || skill.meta.platform.includes(getOs())) &&
        (!skill.meta.arch?.length || skill.meta.arch.includes(getArch()))) {
        this.skills.setSkill(name, skill)
      }
    } catch (error) {
      failed = true
      failure = error
    }
    // Do not destroy the only surviving original if rollback itself failed.
    if (!movedOriginal || installed) {
      try {
        fs.rmSync(transaction, { recursive: true })
      } catch (cleanupError) {
        const message = installed
          ? `Skill saved, but transaction cleanup failed: ${transaction}`
          : `Skill transaction cleanup failed: ${transaction}`
        throw new AggregateError(failed ? [failure, cleanupError] : [cleanupError], message)
      }
    }
    if (failed) throw failure
    return { name, revision: nextRevision, files: Object.keys(files).sort() }
  }
}
