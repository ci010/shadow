import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, realpath, open, link, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { OtioPreviewManifest } from '../shared/otio-effects.ts'
import { assertLocalPath } from './media-profile.ts'

const MAX_BYTES = 64 * 1024
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')
function local(value: string) {
  assertLocalPath(value)
  if (/^[a-z][a-z\d+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) throw new Error('Expected a local filesystem path, not a URI')
}
function validate(value: unknown): asserts value is OtioPreviewManifest {
  const m = value as OtioPreviewManifest
  if (!m || typeof m !== 'object' || Array.isArray(m) || Object.keys(m).sort().join(',') !== 'end,frames,media,profileVersion,rate,sourceSha256,start,version' || m.version !== 1 || m.profileVersion !== 1 || typeof m.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(m.sourceSha256)) throw new Error('Invalid preview manifest format/version/fields')
  if (![m.start, m.end, m.rate, m.frames].every(n => typeof n === 'number' && Number.isFinite(n)) || m.start < 0 || m.end <= m.start || m.rate <= 0 || !Number.isSafeInteger(m.frames) || m.frames <= 0 || Math.abs((m.end - m.start) * m.rate - m.frames) > 1e-6 || Math.abs(m.start * m.rate - Math.round(m.start * m.rate)) > 1e-6) throw new Error('Invalid preview manifest interval/frames')
  if (typeof m.media !== 'string') throw new Error('Unsafe preview media path')
  assertLocalPath(m.media)
  if (!/\.mp4$/i.test(m.media) || /[\\%:#?\x00-\x1f\x7f]/.test(m.media) || m.media.startsWith('/') || m.media.split('/').some(p => !p || p === '.')) throw new Error('Unsafe preview media path')
}
async function plainDirectory(filename: string) {
  const directory = path.dirname(filename)
  if (await realpath(directory) !== directory) throw new Error('Symlink directories are not allowed for preview publishing')
}
async function regular(filename: string) {
  const stat = await lstat(filename)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Preview source/manifest must be a regular file, not a symlink')
}
async function readRegular(filename: string, limit?: number) {
  await plainDirectory(filename)
  await regular(filename)
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Expected regular file')
    if (limit !== undefined) {
      if (stat.size > limit) throw new Error('Preview manifest exceeds 64 KiB')
      const buffer = Buffer.alloc(limit + 1)
      let size = 0
      while (size < buffer.length) {
        const result = await handle.read(buffer, size, buffer.length - size, null)
        if (!result.bytesRead) break
        size += result.bytesRead
      }
      if (size > limit) throw new Error('Preview manifest exceeds 64 KiB')
      return buffer.subarray(0, size)
    }
    return await handle.readFile()
  } finally { await handle.close() }
}

/**
 * Cooperative lock serializes helper writers, not external editors: filesystem rename
 * is not a cross-process compare-and-swap against non-cooperating writers. Path checks
 * reject static symlinks, not hostile concurrent directory replacement. Caller/owner
 * authorization (including permission to access relative media) remains outside this helper.
 */
export async function publishPreviewManifest(file: string, manifest: string, receipt: OtioPreviewManifest, options: { expectedRevision?: string; signal?: AbortSignal } = {}): Promise<{ manifest: string; manifestRevision: string }> {
  // Pure validation must precede all filesystem access.
  local(file); local(manifest); validate(receipt)
  const source = path.resolve(file), target = path.resolve(manifest)
  if (source === target || path.extname(target).toLowerCase() !== '.json') throw new Error('Preview manifest must be a separate .json file')
  const expected = options.expectedRevision
  if (expected !== undefined && (!/^[a-f0-9]{64}$/.test(expected) || target !== `${source}.preview.json`)) throw new Error('Protected preview update requires a SHA256 revision and the fixed source.preview.json path')
  const bytes = Buffer.from(JSON.stringify(receipt, null, 2) + '\n')
  if (bytes.length > MAX_BYTES) throw new Error('Preview manifest exceeds 64 KiB')
  const sourceHash = receipt.sourceSha256
  options.signal?.throwIfAborted()
  await plainDirectory(source); await regular(source); await plainDirectory(target)
  const lock = `${target}.lock`, temporary = `${target}.${randomUUID()}.tmp`
  let ownLock = false, ownTemp = false
  try {
    try { const h = await open(lock, 'wx', 0o600); ownLock = true; await h.close() }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Preview manifest lock conflict; another publisher or retained lock exists'); throw error }
    const check = async () => {
      options.signal?.throwIfAborted()
      if (expected !== undefined) {
        const old = await readRegular(target, MAX_BYTES)
        if (sha256(old) !== expected) throw new Error('Preview manifest revision conflict')
        let parsed: unknown
        try { parsed = JSON.parse(old.toString('utf8')) } catch { throw new Error('Invalid existing preview manifest JSON') }
        validate(parsed)
      } else {
        try { await lstat(target) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
        throw new Error('Preview manifest already exists (no-clobber conflict)')
      }
    }
    await check()
    if (sha256(await readRegular(source)) !== sourceHash) throw new Error('Preview source revision conflict')
    const handle = await open(temporary, 'wx', 0o600); ownTemp = true
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await check()
    if (sha256(await readRegular(source)) !== sourceHash) throw new Error('Preview source revision conflict')
    options.signal?.throwIfAborted()
    if (expected === undefined) await link(temporary, target)
    else await rename(temporary, target)
    return { manifest: target, manifestRevision: sha256(bytes) }
  } finally {
    try { if (ownTemp) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
    finally { if (ownLock) await unlink(lock) }
  }
}
