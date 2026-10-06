import { createHash } from 'node:crypto'
import type { Dirent } from 'node:fs'
import { lstat, mkdir, open, opendir, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { writePrivateFile } from '../src/config/store.ts'
import { appManifestSchema, MAX_BUNDLE_BYTES, MAX_FILE_BYTES, type AppRecord } from '../src/microapps/contracts.ts'
import { bundleRevision, MicroAppStore } from '../src/microapps/store.ts'
import { JsonlSessionStore } from '../src/sessions/session-store-jsonl.ts'
import { resolveSessionLocations } from '../src/sessions/locality.ts'

const excludedDirectories = new Set(['node_modules', 'venv', 'test-data', '__pycache__'])
const sourceExtension = /\.(?:[cm]?[jt]sx?|py|ps1|cs|cpp|c|h|html?|css|scss|json|md|txt|toml|ya?ml|xml|svg|png|jpe?g|ico|wav)$/i
const privateName = /^(?:bot\.config\.json|runtime\.config\.json)$|(?:^|[._-])(?:credentials?|secrets?|tokens?)(?:[._-]|$)/i
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
function within(root: string, path: string) {
  const rel = relative(root, path)
  return rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`)
}

async function isPythonEnvironment(directory: string) {
  try { return (await lstat(join(directory, 'pyvenv.cfg'))).isFile() }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function readOwnedFile(directory: string, path: string): Promise<Buffer> {
  const before = await lstat(path)
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_FILE_BYTES
    || !within(directory, await realpath(path))) throw new Error('Recovery source is not a bounded owned regular file')
  const file = await open(path, 'r')
  try {
    const current = await file.stat()
    if (current.ino !== before.ino || current.dev !== before.dev) throw new Error('Recovery source changed before reading')
    const buffer = Buffer.alloc(before.size + 1)
    let size = 0
    while (size < buffer.length) {
      const read = await file.read(buffer, size, buffer.length - size, null)
      if (!read.bytesRead) break
      size += read.bytesRead
    }
    const after = await file.stat()
    if (size !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      throw new Error('Recovery source changed during snapshot; runtime data retained')
    }
    return buffer.subarray(0, size)
  } finally { await file.close() }
}

export async function exportAcceptanceRecovery(home: string, output: string, publications: AppRecord[], secrets: readonly string[] = []) {
  const owner = await realpath(home)
  if (publications.length > 20) throw new Error('Recovery publication limit exceeded')
  const store = new MicroAppStore(home)
  const bundles = new Map(await Promise.all(publications.map(async record => [record.id, await store.bundle(record)] as const)))
  const states = await new JsonlSessionStore(join(home, '.sessions')).listAllStates()
  const scopes = new Map<string, string[]>()
  for (const state of Object.values(states)) {
    const location = resolveSessionLocations(home, state).workdir
    if (!location.available || location.locality !== 'local') throw new Error('Recovery cannot read an unavailable or remote workdir')
    if (!within(owner, location.path)) throw new Error('Recovery workdir escaped the isolated Project')
    let directory: string
    try { directory = await realpath(location.path) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
      throw error
    }
    if (!within(owner, directory) || within(directory, resolve(output))) throw new Error('Unsafe recovery source/output boundary')
    scopes.set(directory, [...(scopes.get(directory) ?? []), state.sessionId])
  }
  const summaries = []
  let entries = 0, bytes = 0, fileCount = 0, metadataBytes = 0
  for (const [directory, sessions] of scopes) {
    const files: Record<string, { sha256: string; base64: string }> = {}
    const excluded: Array<{ path: string; reason: string }> = []
    const installedFiles = new Set<string>()
    async function walk(folder: string): Promise<void> {
      const children: Dirent[] = []
      for await (const entry of await opendir(folder)) {
        if (++entries > 8192) throw new Error('Recovery directory-entry limit exceeded; runtime data retained')
        children.push(entry)
      }
      // Wheel targets have no pyvenv.cfg. Exclude only recorded files, not adjacent author source.
      for (const entry of children) {
        if (!entry.isDirectory() || !entry.name.endsWith('.dist-info') || entry.name.startsWith('.') || privateName.test(entry.name)) continue
        const metadata = join(folder, entry.name)
        const markers = ['WHEEL', 'METADATA', 'RECORD']
        const regular = await Promise.all(markers.map(async name => {
          try { return (await lstat(join(metadata, name))).isFile() }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
            throw error
          }
        }))
        if (regular.some(value => !value)) continue
        const contents: string[] = []
        for (const name of markers) {
          const content = await readOwnedFile(directory, join(metadata, name))
          metadataBytes += content.length
          if (metadataBytes > MAX_BUNDLE_BYTES) throw new Error('Recovery Python metadata byte limit exceeded; runtime data retained')
          contents.push(new TextDecoder('utf-8', { fatal: true }).decode(content))
        }
        if (!/^Wheel-Version: 1\.\d+\r?$/m.test(contents[0])
          || !/^Metadata-Version: \d+\.\d+\r?$/m.test(contents[1]) || !/^Name: \S+/m.test(contents[1])) {
          throw new Error('Recovery Python distribution metadata is invalid; runtime data retained')
        }
        for (const line of contents[2].split(/\r?\n/)) {
          if (!line) continue
          const record = /^(?:"((?:[^"]|"")*)"|([^",]+)),(?:"[^"]*"|[^",]*),(?:"\d*"|\d*)$/.exec(line)
          if (!record) throw new Error('Recovery Python RECORD is invalid; runtime data retained')
          const name = (record[1] ?? record[2]).replaceAll('""', '"')
          if (!name || name.includes('\\') || name.includes(':') || name.includes('\0')
            || name.split('/').some(part => !part || part === '.' || part === '..')) continue
          const path = resolve(folder, ...name.split('/'))
          if (within(folder, path)) installedFiles.add(path)
        }
      }
      for (const entry of children) {
        const path = join(folder, entry.name), name = relative(directory, path).split(sep).join('/')
        if (entry.name.startsWith('.') || privateName.test(entry.name)
          || entry.isDirectory() && excludedDirectories.has(entry.name.toLowerCase())) {
          excluded.push({ path: name, reason: 'private metadata or generated dependencies/data' }); continue
        }
        if (entry.isSymbolicLink()) {
          excluded.push({ path: name, reason: 'link not followed' }); continue
        }
        if (entry.isDirectory()) {
          if (await isPythonEnvironment(path)) {
            excluded.push({ path: name, reason: 'Python environment identified by regular pyvenv.cfg' }); continue
          }
          await walk(path); continue
        }
        if (entry.isFile() && installedFiles.has(path)) {
          excluded.push({ path: name, reason: 'installed Python dependency listed in distribution RECORD' }); continue
        }
        if (!entry.isFile() || !sourceExtension.test(entry.name)) {
          excluded.push({ path: name, reason: 'outside source export policy' }); continue
        }
        if (++fileCount > 256) throw new Error('Recovery source-file limit exceeded; runtime data retained')
        const content = await readOwnedFile(directory, path)
        if (secrets.some(secret => secret && content.includes(Buffer.from(secret)))) throw new Error('Recovery source contains a runtime credential; export refused')
        bytes += content.length
        if (bytes > MAX_BUNDLE_BYTES) throw new Error('Recovery source byte limit exceeded; runtime data retained')
        files[name] = { sha256: hash(content), base64: content.toString('base64') }
      }
    }
    await walk(directory)
    const candidates = Object.entries(files).filter(([path]) => basename(path) === 'shadow-app.json').map(([path, source]) => {
      const prefix = path.slice(0, -'shadow-app.json'.length)
      let value: unknown
      try { value = JSON.parse(Buffer.from(source.base64, 'base64').toString('utf8').replace(/^\uFEFF/, '')) }
      catch (error) {
        if (!(error instanceof SyntaxError)) throw error
        return { directory: prefix, manifestValid: false, reason: 'Unfinished or invalid JSON manifest; exact bytes preserved' }
      }
      const parsed = appManifestSchema.safeParse(value)
      if (!parsed.success) return { directory: prefix, manifestValid: false, reason: 'Manifest schema is invalid; exact bytes preserved' }
      const manifest = parsed.data
      const missing = manifest.files.filter(path => !files[prefix + path])
      const sourceFiles = Object.keys(files).filter(path => path.startsWith(prefix) && path !== prefix + 'shadow-app.json').map(path => path.slice(prefix.length))
      return {
        directory: prefix, manifestValid: true, missing,
        unlistedSourceFiles: sourceFiles.filter(path => !manifest.files.includes(path)),
        sourceRevision: missing.length ? null : bundleRevision({ manifest,
          files: Object.fromEntries(manifest.files.map(path => [path, files[prefix + path].base64])) }),
        comparisons: publications.filter(record => sessions.includes(record.createdBy)).map(record => ({
          id: record.id, publishedRevision: record.revision, publishedWork: record.work ?? [],
          manifestChanged: JSON.stringify(record.manifest) !== JSON.stringify(manifest),
          changedFiles: [...new Set([...Object.keys(bundles.get(record.id)!.files), ...sourceFiles])]
            .filter(path => bundles.get(record.id)!.files[path] !== files[prefix + path]?.base64),
          acceptanceStatus: record.acceptance?.status ?? 'not_requested',
          requirement: 'Unpublished source and host observations do not imply approval or passed acceptance',
        })),
      }
    })
    const key = createHash('sha256').update(directory).digest('hex').slice(0, 24)
    const archive = join(output, 'recovery', `${key}.json`)
    await mkdir(join(output, 'recovery'), { recursive: true })
    writePrivateFile(archive, JSON.stringify({ version: 1, sourceOnly: true, restoresRuntimeState: false, sessions, files, excluded, candidates }))
    const restored = JSON.parse(await readFile(archive, 'utf8')) as { files: typeof files }
    for (const [path, file] of Object.entries(files)) {
      if (hash(Buffer.from(restored.files[path].base64, 'base64')) !== file.sha256) throw new Error('Recovery archive verification failed')
    }
    summaries.push({ archive: `recovery/${key}.json`, sessions, files: Object.keys(files).length, excluded, candidates })
  }
  return { version: 1, sourceOnly: true, files: fileCount, bytes, scopes: summaries }
}
