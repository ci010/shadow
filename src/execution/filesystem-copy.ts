import { constants } from 'node:fs'
import { lstat, realpath, opendir, open, mkdir, mkdtemp, rm, link } from 'node:fs/promises'
import { dirname, join, relative, isAbsolute } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const COPY_READ = 'filesystem.copy.read'
export const COPY_WRITE = 'filesystem.copy.write'
export const COPY_CHUNK = 64 * 1024
export const COPY_MANIFEST_BYTES = 512 * 1024
const MAX_ENTRIES = 2048
const MAX_BYTES = 1024 * 1024 * 1024
export interface CopyEntry { path: string; kind: 'file' | 'directory'; size: number; hash: string }
interface Stage { root: string; owner: string; destination: string; directory: string; identity: string; files: Map<number, string>; entries: CopyEntry[]; offsets: Map<string, number>; busy: boolean; timer?: ReturnType<typeof setTimeout> }
const identity = (info: { dev: number; ino: number }) => `${info.dev}:${info.ino}`
async function checkStage(stage: Stage): Promise<void> {
  const path = relative(await realpath(stage.root), stage.directory).split('\\').join('/')
  await confined(stage.root, path)
  const info = await lstat(stage.directory)
  if (!info.isDirectory() || identity(info) !== stage.identity) denied()
}
const stages = new Map<string, Stage>()
let pendingBegins = 0
let pendingBytes = 0
function denied(): never { throw new Error('Copy path/type/limit denied') }
function parts(path: unknown, empty = false): string[] {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\\') || path.includes(':') || path.includes('\0') || isAbsolute(path)) return denied()
  if (empty && path === '') return []
  const result = path.split('/')
  if (result.some(p => !p || p === '.' || p === '..' || /[\x00-\x1f\x7f<>"|?*]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p))) return denied()
  return result
}
/** No symlinks, including ancestors; paths are always relative to a host binding. */
async function confined(root: string, path: string, missingLeaf = false): Promise<string> {
  const base = await realpath(root)
  const segments = parts(path, true)
  let current = base
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]!)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory()) || (i < segments.length - 1 && !info.isDirectory())) denied()
    } catch (error) {
      if (missingLeaf && i === segments.length - 1 && (error as NodeJS.ErrnoException).code === 'ENOENT') return current
      throw error
    }
  }
  const rel = relative(base, current)
  if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) denied()
  return current
}
async function digest(path: string, signal: AbortSignal): Promise<{ size: number; hash: string }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!(await file.stat()).isFile()) denied()
    const hash = createHash('sha256'); let size = 0
    const bytes = Buffer.alloc(COPY_CHUNK)
    while (true) {
      signal.throwIfAborted()
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null)
      if (!bytesRead) break
      size += bytesRead
      if (size > MAX_BYTES) denied()
      hash.update(bytes.subarray(0, bytesRead))
    }
    return { size, hash: hash.digest('hex') }
  } finally { await file.close() }
}
export function parseCopyManifest(value: unknown): CopyEntry[] {
  if (!Array.isArray(value) || !value.length || value.length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(value)) > COPY_MANIFEST_BYTES) denied()
  const seen = new Map<string, CopyEntry>(); let total = 0
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') denied()
    parts(entry.path, true)
    if (!['file', 'directory'].includes(entry.kind) || !Number.isSafeInteger(entry.size) || entry.size < 0 || typeof entry.hash !== 'string' || (entry.kind === 'file' ? !/^[a-f0-9]{64}$/.test(entry.hash) : entry.size !== 0 || entry.hash !== '')) denied()
    const key = entry.path.toLowerCase()
    if (seen.has(key) || (seen.size === 0 ? key !== '' : !key || seen.get(key.includes('/') ? key.slice(0, key.lastIndexOf('/')) : '')?.kind !== 'directory')) denied()
    seen.set(key, entry); total += entry.size
    if (total > MAX_BYTES) denied()
  }
  return value.map(entry => ({ path: entry.path, kind: entry.kind, size: entry.size, hash: entry.hash }))
}
function expire(id: string, stage: Stage): void {
  clearTimeout(stage.timer)
  stage.timer = setTimeout(() => {
    if (stage.busy) expire(id, stage)
    else void clean(id, stage).catch(() => { stages.delete(id) })
  }, 10 * 60_000)
  stage.timer.unref()
}
async function clean(id: string, stage: Stage): Promise<void> {
  clearTimeout(stage.timer)
  // Revalidate the parent before touching our private staging directory.
  await checkStage(stage)
  await rm(stage.directory, { recursive: true, force: true })
  stages.delete(id)
}
/** Bounded JSON envelopes only: payload bytes never enter agent text results. */
export async function executeCopyFilesystem(root: string, owner: string, operation: string, value: unknown, signal: AbortSignal): Promise<string> {
  const args = value as Record<string, unknown>
  if (!args || typeof args !== 'object') denied()
  signal.throwIfAborted()
  if (operation === COPY_READ) {
    const path = args.path as string
    if (args.action === 'manifest') {
      const entries: CopyEntry[] = []; let total = 0
      async function walk(input: string, name: string): Promise<void> {
        signal.throwIfAborted()
        const target = await confined(root, input)
        const info = await lstat(target)
        if (entries.length >= MAX_ENTRIES) denied()
        if (info.isDirectory()) {
          entries.push({ path: name, kind: 'directory', size: 0, hash: '' })
          const dir = await opendir(target)
          for await (const child of dir) {
            parts(child.name)
            await walk(input ? `${input}/${child.name}` : child.name, name ? `${name}/${child.name}` : child.name)
          }
        } else {
          const data = await digest(target, signal); total += data.size
          if (total > MAX_BYTES) denied()
          entries.push({ path: name, kind: 'file', ...data })
        }
        if (Buffer.byteLength(JSON.stringify(entries)) > COPY_MANIFEST_BYTES) denied()
      }
      parts(path, true)
      await walk(path, '')
      return JSON.stringify(parseCopyManifest(entries))
    }
    if (args.action !== 'chunk' || !Number.isSafeInteger(args.offset) || (args.offset as number) < 0) denied()
    const target = await confined(root, path)
    const file = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) denied()
      const data = Buffer.alloc(COPY_CHUNK)
      const { bytesRead } = await file.read(data, 0, data.length, args.offset as number)
      signal.throwIfAborted()
      return JSON.stringify({ data: data.subarray(0, bytesRead).toString('base64') })
    } finally { await file.close() }
  }
  if (operation !== COPY_WRITE) denied()
  if (args.action === 'begin') {
    if (stages.size + pendingBegins >= 64) denied()
    const entries = parseCopyManifest(args.entries)
    const reserved = [...stages.values()].reduce((sum, stage) => sum + stage.entries.reduce((n, entry) => n + entry.size, 0), 0)
    const bytes = entries.reduce((sum, entry) => sum + entry.size, 0)
    if (reserved + pendingBytes + bytes > MAX_BYTES) denied()
    pendingBegins++; pendingBytes += bytes
    try {
      parts(args.path)
      const destination = await confined(root, args.path as string, true)
      try { await lstat(destination); throw new Error('Copy destination already exists') } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      const directory = await mkdtemp(join(dirname(destination), '.shadow-copy-'))
      const id = randomUUID()
      const stage: Stage = { root, owner, destination, directory, identity: identity(await lstat(directory)), files: new Map(), entries, offsets: new Map(), busy: true }
      stages.set(id, stage); expire(id, stage)
      try {
        for (let i = 0; i < entries.length; i++) if (entries[i]!.kind === 'file') {
          signal.throwIfAborted()
          const file = await open(join(directory, String(i)), 'wx', 0o600)
          try { stage.files.set(i, identity(await file.stat())) } finally { await file.close() }
          stage.offsets.set(entries[i]!.path, 0)
        }
        signal.throwIfAborted()
        stage.busy = false
        expire(id, stage)
        return JSON.stringify({ id })
      } catch (error) { stage.busy = false; await clean(id, stage); throw error }
    } finally { pendingBegins--; pendingBytes -= bytes }
  }
  const id = args.id as string; const stage = stages.get(id)
  if (!stage || stage.owner !== owner || stage.root !== root || stage.busy) denied()
  stage.busy = true
  try {
    if (args.action === 'abort') { await clean(id, stage); return '{}' }
    if (args.action === 'chunk') {
      const index = stage.entries.findIndex(e => e.path === args.path && e.kind === 'file')
      const entry = stage.entries[index]
      if (!entry || typeof args.data !== 'string' || args.data.length > Math.ceil(COPY_CHUNK / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(args.data)) denied()
      const data = Buffer.from(args.data, 'base64')
      const offset = stage.offsets.get(entry.path)!
      if (args.offset !== offset || !data.length || offset + data.length > entry.size) denied()
      await checkStage(stage)
      const file = await open(join(stage.directory, String(index)), constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const info = await file.stat()
        if (!info.isFile() || info.nlink !== 1 || identity(info) !== stage.files.get(index)) denied()
        let written = 0
        while (written < data.length) {
          signal.throwIfAborted()
          const result = await file.write(data, written, data.length - written, offset + written)
          if (!result.bytesWritten) throw new Error('Copy write made no progress')
          written += result.bytesWritten
        }
      } finally { await file.close() }
      stage.offsets.set(entry.path, offset + data.length)
      return '{}'
    }
    if (args.action !== 'commit') denied()
    await checkStage(stage)
    for (let i = 0; i < stage.entries.length; i++) {
      const entry = stage.entries[i]!
      signal.throwIfAborted()
      if (entry.kind === 'file') {
        const actual = await digest(join(stage.directory, String(i)), signal)
        if (stage.offsets.get(entry.path) !== entry.size || actual.hash !== entry.hash || actual.size !== entry.size) throw new Error('Copy integrity check failed')
      }
    }
    const destinationPath = relative(await realpath(root), stage.destination).split('\\').join('/')
    await confined(root, destinationPath, true)
    // Exclusive mkdir/link: never replace an existing destination, even at publication.
    for (let i = 0; i < stage.entries.length; i++) {
      signal.throwIfAborted()
      const entry = stage.entries[i]!
      const path = entry.path ? `${destinationPath}/${entry.path}` : destinationPath
      const target = await confined(root, path, true)
      if (entry.kind === 'directory') await mkdir(target)
      else await link(join(stage.directory, String(i)), target)
    }
    await clean(id, stage)
    return JSON.stringify({ status: 'completed', entries: stage.entries.length })
  } finally {
    stage.busy = false
    if (stages.has(id)) expire(id, stage)
  }
}
