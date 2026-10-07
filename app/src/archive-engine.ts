import SevenZip, { type SevenZipModule, type SevenZipModuleOptions } from '7z-wasm'
import { ARCHIVE_ENTRY_MAX_BYTES, ARCHIVE_MAX_BYTES, ARCHIVE_MAX_DEPTH, ARCHIVE_MAX_ENTRIES,
  archivePath, type ArchiveMember, type ArchiveRequest, type ArchiveResult } from './archive-format.ts'

/** 7-Zip's technical listing is metadata only; no member is extracted by `l`. */
export function parseArchiveListing(text: string, streamName?: string): ArchiveMember[] {
  const result: ArchiveMember[] = []
  const paths = new Set<string>()
  const blocks = text.replace(/[\r\n]+$/, '').split(/\r?\n\r?\n/).filter(block => block.trim())
  for (const block of blocks) {
    const fields = new Map<string, string>()
    for (const line of block.split(/\r?\n/)) {
      const separator = line.indexOf(' = ')
      if (separator < 1) throw new Error('This archive has an unsupported directory listing.')
      const key = line.slice(0, separator)
      if (fields.has(key)) throw new Error('This archive has ambiguous directory metadata.')
      fields.set(key, line.slice(separator + 3))
    }
    const stream = !fields.has('Path') && !!streamName && blocks.length === 1
    const rawPath = fields.get('Path') ?? (stream ? streamName! : '')
    if ((rawPath === '.' || rawPath === './') && fields.get('Folder') === '+') continue
    const path = archivePath(rawPath)
    if (paths.has(path)) throw new Error('This archive contains duplicate entry paths.')
    paths.add(path)
    const attributes = fields.get('Attributes') || fields.get('Mode') || ''
    const type = fields.get('Folder') === '+' || /^D|^d| d/.test(attributes) ? 'dir' : 'file'
    const size = Number(fields.get('Size') || 0)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('This archive has an invalid entry size.')
    result.push({ path, type, size, encrypted: fields.get('Encrypted') === '+',
      link: !!fields.get('Symbolic Link') || !!fields.get('Hard Link') || /(?:^| )[lbcps][rwx-]/.test(attributes),
      ...(stream ? { stream: true } : {}) })
    if (result.length > ARCHIVE_MAX_ENTRIES) throw new Error('This archive contains more than 50,000 entries. Download it to browse locally.')
  }
  return result
}

export async function createArchiveEngine(options: Partial<SevenZipModuleOptions> = {}) {
  let chunks: Uint8Array[] = []
  let chunk = new Uint8Array(65536)
  let cursor = 0
  let total = 0
  let limit = 0
  let errors = ''
  const module = await SevenZip({
    ...options, stdin: () => -1,
    stdout(byte) {
      if (++total > limit) throw new Error('Archive output exceeds the preview limit. Download it to browse locally.')
      chunk[cursor++] = byte
      if (cursor === chunk.length) { chunks.push(chunk); chunk = new Uint8Array(65536); cursor = 0 }
    },
    stderr(byte) { if (errors.length < 8192) errors += String.fromCharCode(byte) },
  })

  function command(args: string[], maxBytes: number): Uint8Array<ArrayBuffer> {
    chunks = []; chunk = new Uint8Array(65536); cursor = 0; total = 0; limit = maxBytes; errors = ''
    try {
      // The package declares void, but Emscripten returns the CLI's exit code.
      const status: unknown = module.callMain([args[0]!, '-bd', '-bsp0', '-bse2', '-y', ...args.slice(1)])
      if (status !== 0 && status !== undefined) throw new Error(`Archive decoder exited with code ${String(status)}.`)
    } catch (cause) {
      throw new Error(errors.trim() || (cause instanceof Error ? cause.message : 'The archive is damaged, encrypted, or unsupported.'))
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const part of chunks) { bytes.set(part, offset); offset += part.length }
    bytes.set(chunk.subarray(0, cursor), offset)
    chunks = []
    return bytes
  }

  const names = new Map<string, string>()
  const list = (path: string) => {
    const name = names.get(path) ?? path.split('/').at(-1)!
    const streamName = /\.(?:tbz2?|txz)$/i.test(name) ? name.replace(/\.(?:tbz2?|txz)$/i, '.tar')
      : /\.(?:bz2|xz)$/i.test(name) ? name.replace(/\.(?:bz2|xz)$/i, '') : undefined
    return parseArchiveListing(new TextDecoder().decode(command(['l', '-slt', '-ba', '--', path], 16 * 1024 * 1024)),
      streamName)
  }
  function extract(path: string, member: ArchiveMember, maxBytes: number): Uint8Array<ArrayBuffer> {
    if (member.type !== 'file' || member.link) throw new Error('Archive links and special entries cannot be previewed.')
    if (member.encrypted) throw new Error('Password-protected entries cannot be previewed. Download the archive to open it locally.')
    if (member.size > maxBytes) throw new Error(`This archive entry exceeds the ${maxBytes / 1024 / 1024} MB preview limit.`)
    // Stream to stdout rather than extracting archive-controlled paths to a filesystem.
    const bytes = command(['x', '-so', '-spd', '-bso0', '--', path, ...(member.stream ? [] : [member.path])], maxBytes)
    if ((!member.stream || member.size > 0) && bytes.length !== member.size) {
      throw new Error('The extracted entry does not match its directory metadata. The archive may be damaged.')
    }
    return bytes
  }
  let serial = 0
  function write(bytes: Uint8Array, name: string) {
    const path = `/content-${serial++}-${name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    module.FS.writeFile(path, bytes)
    names.set(path, name)
    return path
  }
  function unwrap(path: string, name: string): string {
    if (!/(?:\.tar\.(?:gz|bz2|xz)|\.tgz|\.tbz2?|\.txz)$/i.test(name)) return path
    const entries = list(path)
    if (entries.length !== 1 || entries[0]!.type !== 'file') throw new Error('Invalid compressed TAR container.')
    return write(extract(path, entries[0]!, ARCHIVE_MAX_BYTES), 'content.tar')
  }
  function run(inputPath: string, request: Pick<ArchiveRequest, 'name' | 'members' | 'mode'>): ArchiveResult {
    if (request.members.length > ARCHIVE_MAX_DEPTH) throw new Error('Nested archives are limited to four levels.')
    names.set(inputPath, request.name)
    let path = unwrap(inputPath, request.name)
    for (const [index, name] of request.members.entries()) {
      const wanted = archivePath(name)
      const member = list(path).find(entry => entry.path === wanted)
      if (!member) throw new Error('This archive entry is no longer available. Refresh the file tree.')
      const bytes = extract(path, member, ARCHIVE_ENTRY_MAX_BYTES)
      if (request.mode === 'read' && index === request.members.length - 1) return { bytes }
      path = unwrap(write(bytes, name.split('/').at(-1)!), name)
    }
    if (request.mode === 'read') throw new Error('No archive entry was selected.')
    return { entries: list(path) }
  }
  return { module, run }
}

export function mountArchiveFile(module: SevenZipModule, file: Blob, name: string): string {
  module.FS.mkdir('/input')
  // WORKERFS reads Blob slices on demand and never touches the host filesystem.
  const basename = name.replace(/[^a-zA-Z0-9._-]/g, '_')
  module.FS.mount(module.WORKERFS, { blobs: [{ name: basename, data: file }] }, '/input')
  return `/input/${basename}`
}
