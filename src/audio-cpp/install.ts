import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { inflateRawSync, crc32 } from 'node:zlib'
import { chmod, mkdir, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Aria2Downloader } from '../downloader/aria2.ts'

const artifact = z.object({ url: z.string().url(), sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().positive().safe() }).strict()
export const setupSchema = z.object({
  approved: z.literal(true),
  binary: artifact.extend({ entry: z.string().min(1), platform: z.enum(['win32', 'linux', 'darwin']), arch: z.enum(['x64', 'arm64']) }).strict(),
  model: artifact.extend({ family: z.string().regex(/^[a-z][a-z0-9_]*$/) }).strict(),
  task: z.enum(['asr', 'tts']), backend: z.enum(['cpu', 'cuda', 'vulkan', 'metal', 'hip', 'best']).default('cpu'), options: z.array(z.string()).default([]),
}).strict()
export type SetupRequest = z.input<typeof setupSchema>
export type ArtifactDownloader = Pick<Aria2Downloader, 'download'>

function safeEntry(name: string): string {
  if (!name || name.includes('\\') || name.startsWith('/') || name.split('/').some(p => p === '..' || p === '.' || /[:\x00-\x1f]/.test(p))) throw new Error('Unsafe ZIP entry')
  return name
}

// Ordinary stored/deflated ZIP only. No shell, ZIP64, links or special files.
export async function extractZip(bytes: Buffer, directory: string, signal?: AbortSignal): Promise<void> {
  let end = -1
  for (let p = bytes.length - 22; p >= Math.max(0, bytes.length - 65557); p--) {
    if (bytes.readUInt32LE(p) === 0x06054b50 && p + 22 + bytes.readUInt16LE(p + 20) === bytes.length) { end = p; break }
  }
  if (end < 0 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new Error('Unsupported ZIP')
  const count = bytes.readUInt16LE(end + 10)
  let cursor = bytes.readUInt32LE(end + 16)
  if (count === 65535 || cursor + bytes.readUInt32LE(end + 12) !== end) throw new Error('Unsupported ZIP directory')
  const names = new Set<string>()
  let total = 0
  for (let i = 0; i < count; i++) {
    signal?.throwIfAborted()
    if (bytes.readUInt32LE(cursor) !== 0x02014b50) throw new Error('Invalid ZIP directory')
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10)
    const expectedCrc = bytes.readUInt32LE(cursor + 16)
    const compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24)
    const length = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32)
    const attributes = bytes.readUInt32LE(cursor + 38), local = bytes.readUInt32LE(cursor + 42)
    const name = safeEntry(bytes.toString('utf8', cursor + 46, cursor + 46 + length))
    cursor += 46 + length + extra + comment
    const kind = (attributes >>> 16) & 0xf000
    if ((kind && kind !== 0x8000 && kind !== 0x4000) || flags & 1 || ![0, 8].includes(method)) throw new Error('Unsupported ZIP entry type')
    const key = name.replace(/\/$/, '').toLowerCase()
    if (names.has(key) || name.split('/').some(p => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p) || /[. ]$/.test(p))) throw new Error('Unsafe or duplicate ZIP entry')
    names.add(key)
    total += size
    if (total > 2 * 1024 ** 3 || size > 512 * 1024 ** 2) throw new Error('ZIP extraction limit exceeded')
    const path = join(directory, name)
    if (name.endsWith('/')) { await mkdir(path, { recursive: true }); continue }
    if (bytes.readUInt32LE(local) !== 0x04034b50) throw new Error('Invalid ZIP entry')
    const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28)
    if (start + compressed > end) throw new Error('Truncated ZIP entry')
    const data = method === 0 ? bytes.subarray(start, start + compressed) : inflateRawSync(bytes.subarray(start, start + compressed), { maxOutputLength: Math.max(1, size) })
    if (data.length !== size || crc32(data) !== expectedCrc) throw new Error('ZIP size mismatch')
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, data, { flag: 'wx', mode: 0o600 })
  }
  if (cursor !== end) throw new Error('Invalid ZIP directory length')
}

export class AudioCppInstaller {
  constructor(private readonly root: string, private readonly downloader: ArtifactDownloader = new Aria2Downloader()) {}
  async install(request: SetupRequest, signal?: AbortSignal, probe?: (binary: string) => Promise<void>): Promise<{ binary: string; path: string }> {
    const input = setupSchema.parse(request)
    if (input.binary.platform !== process.platform || input.binary.arch !== process.arch) throw new Error('audio.cpp package does not match this host')
    const entry = safeEntry(input.binary.entry)
    if (entry.split('/').at(-1) !== (process.platform === 'win32' ? 'audiocpp_cli.exe' : 'audiocpp_cli')) throw new Error('Expected audiocpp_cli ZIP entry')
    const cache = join(this.root, 'downloads')
    await mkdir(cache, { recursive: true })
    const download = async (spec: z.infer<typeof artifact>, extension: string) => {
      const filename = spec.sha256 + extension
      // Strip model/host metadata: downloader enforces a strict request contract.
      await this.downloader.download({ url: spec.url, sha256: spec.sha256, bytes: spec.bytes, approved: true, directory: cache, filename }, signal)
      signal?.throwIfAborted()
      const path = join(cache, filename)
      const hash = createHash('sha256')
      for await (const chunk of createReadStream(path)) { signal?.throwIfAborted(); hash.update(chunk) }
      if ((await stat(path)).size !== spec.bytes || hash.digest('hex') !== spec.sha256) throw new Error('Downloaded artifact integrity mismatch')
      return path
    }
    if (input.binary.bytes > 512 * 1024 ** 2) throw new Error('ZIP archive exceeds 512 MiB limit')
    const archive = await download(input.binary, '.zip')
    const target = join(this.root, 'packages', input.binary.sha256)
    const stage = target + '.staging'
    await rm(stage, { recursive: true, force: true })
    await mkdir(stage, { recursive: true })
    try {
      await extractZip(await readFile(archive), stage, signal)
      if (!(await stat(join(stage, entry))).isFile()) throw new Error('CLI is absent from package')
      await chmod(join(stage, entry), 0o700)
      signal?.throwIfAborted()
      await rm(target, { recursive: true, force: true })
      await rename(stage, target)
    } finally { await rm(stage, { recursive: true, force: true }) }
    await probe?.(join(target, entry))
    const path = await download(input.model, '.gguf')
    const file = await open(path, 'r')
    try {
      const header = Buffer.alloc(4)
      await file.read(header, 0, 4, 0)
      if (header.toString('ascii') !== 'GGUF') throw new Error('Model is not GGUF')
    } finally { await file.close() }
    return { binary: join(target, entry), path }
  }
}
