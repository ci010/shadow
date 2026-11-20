import { createHash } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

export const THREE_LIMITS = { marker: 32 * 1024, source: 256 * 1024, asset: 1024 * 1024, modulesTotal: 1024 * 1024, assetsTotal: 1024 * 1024, shadersTotal: 256 * 1024, shaderText: 32_768, modules: 32, assets: 16, shaders: 16 } as const
export class ThreeSnapshotError extends Error {
  constructor(readonly code: string, readonly status: 400 | 404 | 409 | 413, readonly file?: string) { super(code) }
}
const fail = (code: string, status: ThreeSnapshotError['status'], file?: string): never => { throw new ThreeSnapshotError(code, status, file) }
const retry = (file?: string): never => fail('snapshot_changed_retry', 409, file)
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
const decode = (bytes: Buffer, file: string): string => {
  try { return decoder.decode(bytes) } catch { return fail('invalid_utf8', 400, file) }
}
function safeSegment(part: string): boolean {
  if (part.length > 128 || !/^[\p{L}\p{M}\p{N}_-]/u.test(part) ||
    /[^\p{L}\p{M}\p{N}_. -]/u.test(part) || /[. ]$/.test(part)) return false
  // Compare reserved names canonically without changing the filesystem lookup or wire key.
  const name = part.normalize('NFC')
  return !/^(?:con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³]) *(?:\.|$)/iu.test(name) &&
    !/^(?:node_modules|credentials|secrets|workspace)$/iu.test(name) &&
    !/^(?:bot\.config|id_rsa|id_ed25519|credentials|secrets)(?:\.|$)/iu.test(name)
}
function pathOf(value: unknown, suffix: RegExp, marker?: string): string {
  if (typeof value !== 'string' || value.length > 240 || !suffix.test(value) ||
    value.split('/').length > 12 || !value.split('/').every(safeSegment)) {
    return fail('invalid_snapshot_path', 400, marker)
  }
  return value
}
const signature = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.mode}:${s.nlink}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`
type Seen = { path: string; tag: string; stat: BigIntStats }
async function inspect(root: string, file: string): Promise<Seen[]> {
  let path = root
  const parts = file.split('/')
  const chain: Seen[] = []
  try {
    for (let i = 0; i <= parts.length; i++) {
      if (i) path = join(path, parts[i - 1]!)
      const stat = await lstat(path, { bigint: true })
      if (i === parts.length ? !stat.isFile() || stat.nlink !== 1n : !stat.isDirectory()) fail('unsafe_snapshot_file', 400, file)
      chain.push({ path, stat, tag: signature(stat) })
    }
    if (relative(path, await realpath(path)) !== '') fail('unsafe_snapshot_file', 400, file)
    // Recheck the ancestry after observing the leaf so a replaced parent can't
    // pair an unrelated file identity with the original directory chain.
    for (let i = chain.length - 2; i >= 0; i--) {
      const entry = chain[i]!
      const stat = await lstat(entry.path, { bigint: true }).catch(() => retry(file))
      if (signature(stat) !== entry.tag) retry(file)
    }
  } catch (error) {
    if (error instanceof ThreeSnapshotError) throw error
    return fail('snapshot_file_unavailable', 404, file)
  }
  return chain
}
function same(a: Seen[], b: Seen[]) { return a.length === b.length && a.every((entry, i) => entry.tag === b[i]?.tag) }
async function verify(root: string, file: string, before: Seen[]) {
  const now = await inspect(root, file).catch(() => retry(file))
  if (!same(before, now)) retry(file)
}
async function readInput(root: string, file: string, before: Seen[]): Promise<Buffer> {
  const leaf = before.at(-1)!
  const handle = await open(leaf.path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)).catch(() => retry(file))
  try {
    if (signature(await handle.stat({ bigint: true })) !== leaf.tag) retry(file)
    await verify(root, file, before)
    const bytes = Buffer.alloc(Number(leaf.stat.size) + 1)
    let offset = 0
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset)
      if (!bytesRead) break
      offset += bytesRead
    }
    if (offset !== bytes.length - 1 || signature(await handle.stat({ bigint: true })) !== leaf.tag) retry(file)
    return bytes.subarray(0, offset)
  } catch { return retry(file) } finally { await handle.close().catch(() => {}) }
}

export async function readThreeSnapshot(base: string, input: unknown, ifNoneMatch?: string, signal?: AbortSignal) {
  const marker = pathOf(input, /(?:^|\/)playground\.three\.json$/)
  const anchor = await lstat(base, { bigint: true }).catch(() => fail('snapshot_root_unavailable', 404, marker))
  if (!anchor.isDirectory()) fail('unsafe_snapshot_file', 400, marker)
  const root = await realpath(base).catch(() => retry(marker))
  const checkAnchor = async () => {
    const resolved = await lstat(root, { bigint: true }).catch(() => retry(marker))
    if (signature(anchor) !== signature(resolved) || await realpath(base).catch(() => retry(marker)) !== root) retry(marker)
  }
  await checkAnchor()
  const directory = dirname(marker)
  const full = (file: string) => directory === '.' ? file : `${directory}/${file}`
  const inputs = new Map<string, Seen[]>()
  const abort = () => { if (signal?.aborted) fail('snapshot_cancelled', 409, marker) }
  const add = async (file: string, max: number) => {
    abort()
    if (inputs.has(file)) return inputs.get(file)!
    const seen = await inspect(root, file)
    if (seen[0]?.tag !== signature(anchor)) retry(file)
    const size = seen.at(-1)!.stat.size
    if (size > BigInt(max)) fail('snapshot_size_limit', 413, file)
    inputs.set(file, seen)
    return seen
  }
  const markerBytes = await readInput(root, marker, await add(marker, THREE_LIMITS.marker))
  const markerText = decode(markerBytes, marker)
  const invalid = () => fail('invalid_snapshot_marker', 400, marker)
  const manifest: unknown = (() => { try { return JSON.parse(markerText) } catch { return invalid() } })()
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return invalid()
  const { files, assets = [], shaders = [] } = manifest as Record<string, unknown>
  const list = (value: unknown, max: number): unknown[] => {
    if (!Array.isArray(value)) return invalid()
    if (value.length > max) fail('snapshot_count_limit', 413, marker)
    return value
  }
  const modules = list(files, THREE_LIMITS.modules).map(file => pathOf(file, /\.(?:mjs|js)$/, marker))
  const resources = list(assets, THREE_LIMITS.assets).map(file => pathOf(file, /^assets\/.+\.(?:glb|gltf|bin|png|jpe?g|webp|gif|avif|ktx2|hdr|exr|dds|basis|woff2?|ttf|otf|mp3|wav|ogg)$/i, marker))
  if (!modules.includes('main.mjs') || new Set(modules).size !== modules.length || new Set(resources).size !== resources.length) return invalid()
  const slots = new Set<string>()
  const bindings = list(shaders, THREE_LIMITS.shaders).map(binding => {
    if (!binding || typeof binding !== 'object' || Array.isArray(binding)) return invalid()
    const { objectId, slot, vertex, fragment } = binding as Record<string, unknown>
    if (typeof objectId !== 'string' || !objectId.length || objectId.length > 256 || typeof slot !== 'number' || !Number.isSafeInteger(slot) || slot < 0) return invalid()
    const key = JSON.stringify([objectId, slot])
    if (slots.has(key)) return invalid()
    slots.add(key)
    return { objectId, slot, vertex: pathOf(vertex, /^shaders\/.+\.(?:vert|vs|glsl)$/, marker), fragment: pathOf(fragment, /^shaders\/.+\.(?:frag|fs|glsl)$/, marker) }
  })
  const budget = async (files: string[], perFile: number, limit: number) => {
    let total = 0n
    for (const file of files) {
      const chain = await add(full(file), perFile)
      total += chain.at(-1)!.stat.size
      if (total > BigInt(limit)) fail('snapshot_size_limit', 413, full(file))
    }
  }
  await budget(modules, THREE_LIMITS.source, THREE_LIMITS.modulesTotal)
  await budget(resources, THREE_LIMITS.asset, THREE_LIMITS.assetsTotal)
  // Count repeated bindings too: their text is repeated on the wire.
  await budget(bindings.flatMap(({ vertex, fragment }) => [vertex, fragment]), THREE_LIMITS.source, THREE_LIMITS.shadersTotal)
  const stamp = createHash('sha256').update(markerBytes)
  for (const [file, chain] of inputs) stamp.update(JSON.stringify([file, chain.map(entry => entry.tag)]))
  const etag = `"${stamp.digest('hex')}"`
  const verifyAll = async () => {
    for (const [file, chain] of inputs) { abort(); await verify(root, file, chain) }
    await checkAnchor()
  }
  if (ifNoneMatch?.split(',').some(tag => tag.trim().replace(/^W\//, '') === etag)) {
    await verifyAll()
    return { etag }
  }
  const bytes = new Map([[marker, markerBytes]])
  const content = createHash('sha256')
  for (const [file, chain] of inputs) {
    abort()
    const data = bytes.get(file) ?? await readInput(root, file, chain)
    bytes.set(file, data)
    content.update(JSON.stringify([directory === '.' ? file : file.slice(directory.length + 1), data.length])).update(data)
  }
  await verifyAll()
  const source = (file: string) => decode(bytes.get(full(file))!, full(file))
  const shaderSource = (file: string) => {
    const text = source(file)
    if (text.length > THREE_LIMITS.shaderText) fail('snapshot_shader_text_limit', 413, full(file))
    return text
  }
  return { etag, snapshot: {
    version: content.digest('hex'),
    files: Object.fromEntries(modules.map(file => [file, source(file)])),
    assets: Object.fromEntries(resources.map(file => [file, bytes.get(full(file))!.toString('base64')])),
    shaders: bindings.map(({ objectId, slot, vertex, fragment }) => ({ objectId, slot, vertex: shaderSource(vertex), fragment: shaderSource(fragment) })),
  } }
}
