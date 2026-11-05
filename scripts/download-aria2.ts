import { createHash } from 'node:crypto'
import { Agent, get } from 'node:https'
import { gunzipSync } from 'node:zlib'
import { mkdtemp, readFile, writeFile, copyFile, rm, mkdir, lstat, readdir, rename } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'
import { ARIA2_REVISION, aria2Executable, verifyAria2Package } from './aria2-package.ts'

export const release = 'aria2-1.37.0-shadow.1'
export function unpackBundle(archive: Buffer, binary: string): Map<string, Buffer> {
  const tar = gunzipSync(archive, { maxOutputLength: 100 * 1024 * 1024 })
  const allowed = new Set([binary, 'COPYING', 'LICENSE.OpenSSL', 'build-aria2-native.sh', 'wslay-autoconf.patch', 'aria2-1.37.0-source.tar.gz', 'THIRD-PARTY-NOTICES.txt'])
  const files = new Map<string, Buffer>()
  for (let offset = 0; offset + 512 <= tar.length;) {
    const h = tar.subarray(offset, offset + 512)
    if (h.every(byte => byte === 0)) break
    const string = (start: number, end: number) => h.subarray(start, end).toString().replace(/\0.*$/s, '')
    const checksum = parseInt(string(148, 156).trim(), 8)
    let sum = 0
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : h[i]!
    if (sum !== checksum) throw new Error('Invalid tar checksum')
    const raw = string(0, 100)
    const name = raw.replace(/^\.\//, '')
    const size = parseInt(string(124, 136).trim() || '0', 8)
    const type = h[156]
    if (!Number.isSafeInteger(size) || size < 0 || offset + 512 + size > tar.length) throw new Error('Invalid tar size')
    if (raw === './' && type === 53 && size === 0) { offset += 512; continue }
    if (string(345, 500) || !allowed.has(name) || files.has(name) || (type !== 0 && type !== 48)) throw new Error(`Unsafe tar entry: ${raw}`)
    files.set(name, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (files.size !== allowed.size) throw new Error('Incomplete aria2 bundle')
  return files
}

export function verifyArchiveDigest(bytes: Buffer, expected: string): void {
  if (!/^[a-f0-9]{64}$/.test(expected) || createHash('sha256').update(bytes).digest('hex') !== expected) {
    throw new Error('aria2 SHA256 mismatch')
  }
}

// Node 24 native proxy support respects explicit HTTPS_PROXY/NO_PROXY without
// changing TLS verification. Hosted CI normally downloads directly.
const agent = new Agent({ proxyEnv: process.env })
export function download(url: string, redirects = 0): Promise<Buffer> {
  if (redirects > 5 || new URL(url).protocol !== 'https:') throw new Error('Unsafe download redirect')
  return new Promise((resolve, reject) => {
    const request = get(url, { agent }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && response.headers.location) {
        response.resume(); download(new URL(response.headers.location, url).href, redirects + 1).then(resolve, reject); return
      }
      if (response.statusCode !== 200) { response.resume(); reject(new Error(`Download HTTP ${response.statusCode}`)); return }
      const chunks: Buffer[] = []; let size = 0
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 60 * 1024 * 1024) response.destroy(new Error('Archive too large')); else chunks.push(chunk) })
      response.on('error', reject); response.on('end', () => resolve(Buffer.concat(chunks)))
    })
    request.setTimeout(60_000, () => request.destroy(new Error('Download timeout')))
    request.on('error', reject)
  })
}

export async function installAria2(root: string): Promise<void> {
  const target = desktopTarget()
  const key = `${target.platform}-${target.arch}`
  const lock = JSON.parse(await readFile(join(root, 'scripts', 'aria2-native-lock.json'), 'utf8'))
  const entry = lock.assets[key]
  const expectedURL = `https://github.com/ci010/shadow-native-deps/releases/download/${release}/${release}-${key}.tar.gz`
  if (lock.release !== release || lock.sourceRevision !== ARIA2_REVISION || entry?.url !== expectedURL || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new Error('Missing pinned aria2 release digest')
  const bytes = await download(entry.url)
  verifyArchiveDigest(bytes, entry.sha256)
  await installBundle(root, bytes, target)
}

export async function installBundle(root: string, bytes: Buffer, target: DesktopTarget,
  run?: Parameters<typeof verifyAria2Package>[2],
): Promise<void> {
  const binary = aria2Executable(target)
  const files = unpackBundle(bytes, binary)
  const destination = join(root, 'desktop', 'aria2')
  for (const directory of [root, join(root, 'desktop'), destination]) {
    if (!(await lstat(directory)).isDirectory()) throw new Error(`Not a regular directory: ${directory}`)
  }
  for (const name of await readdir(destination)) {
    if ((!files.has(name) && name !== 'BUILD.md') || !(await lstat(join(destination, name))).isFile()) {
      throw new Error(`Unexpected existing aria2 entry: ${name}`)
    }
  }
  const staging = await mkdtemp(join(root, 'desktop', '.aria2-download-'))
  const backup = join(staging, 'previous')
  let moved = false
  try {
    const output = join(staging, 'desktop', 'aria2')
    await mkdir(output, { recursive: true })
    for (const [name, content] of files) await writeFile(join(output, name), content, { mode: name === binary ? 0o755 : 0o644 })
    await copyFile(join(destination, 'BUILD.md'), join(output, 'BUILD.md'))
    for (const recipe of ['build-aria2-native.sh', 'wslay-autoconf.patch']) {
      if (!files.get(recipe)!.equals(await readFile(join(root, 'scripts', recipe)))) throw new Error('aria2 recipe mismatch')
    }
    await verifyAria2Package(staging, target, run)
    // Same-filesystem directory swap; keep the old complete bundle for rollback.
    await rename(destination, backup)
    moved = true
    try { await rename(output, destination) }
    catch (error) { await rename(backup, destination); moved = false; throw error }
    moved = false
  } finally {
    // If rollback itself failed, retain the previous bundle for manual recovery.
    if (!moved) await rm(staging, { recursive: true, force: true })
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await installAria2(process.cwd())
