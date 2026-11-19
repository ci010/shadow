import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { lstat, readdir, readFile, mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { download, verifyArchiveDigest } from './download-aria2.ts'
import { recordNativeBuild } from './agent-desktop-integrity.ts'

export const agentDesktopRelease = 'agent-desktop-0.10.1-shadow.1'
export const agentDesktopRevision = '5a2c9ad43e269164a8adc8978a733c40b1d38a8b'
export const bundleFiles = ['shadow-agent-desktop.node', 'shadow-input-guard.exe', 'LICENSE', 'NOTICE', 'source.tar.gz', 'THIRD-PARTY-NOTICES.json', 'provenance.json']

/** Actual native inputs only. App/worker edits do not rebuild or version native dependencies. */
export async function nativeRecipeFingerprint(root: string): Promise<string> {
  const base = 'integrations/agent-desktop'
  const paths = ['Cargo.toml', 'Cargo.lock', 'build.rs'].map(name => `${base}/${name}`)
  async function walk(directory: string) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const name = `${directory}/${entry.name}`
      if (entry.isDirectory()) await walk(name)
      else if (entry.isFile()) paths.push(name)
      else throw new Error('Unsafe native recipe input')
    }
  }
  for (const name of ['src', 'patches']) await walk(`${base}/${name}`)
  paths.push('src/execution/computer/windows-input.cs', 'scripts/agent-desktop-input-guard.ts')
  const hash = createHash('sha256')
  for (const name of paths.sort()) hash.update(name).update('\0').update(await readFile(join(root, name))).update('\0')
  return hash.digest('hex')
}

export function unpackAgentDesktopBundle(bytes: Buffer): Map<string, Buffer> {
  const tar = gunzipSync(bytes, { maxOutputLength: 180 * 1024 * 1024 })
  const files = new Map<string, Buffer>()
  let offset = 0
  while (offset + 512 <= tar.length) {
    const h = tar.subarray(offset, offset + 512)
    if (h.every(n => n === 0)) break
    const text = (start: number, end: number) => h.subarray(start, end).toString().replace(/\0.*$/s, '')
    let checksum = 0
    for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : h[i]!
    const name = text(0, 100), size = parseInt(text(124, 136).trim() || '0', 8)
    if (checksum !== parseInt(text(148, 156).trim(), 8) || text(345, 500)
      || !bundleFiles.includes(name) || files.has(name) || ![0, 48].includes(h[156]!)
      || !Number.isSafeInteger(size) || size <= 0 || offset + 512 + size > tar.length) throw new Error(`Unsafe native bundle entry: ${name}`)
    files.set(name, tar.subarray(offset + 512, offset + 512 + size))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  if (files.size !== bundleFiles.length) throw new Error('Incomplete agent-desktop bundle')
  return files
}

export function validateNativePE(bytes: Buffer, arch: string): void {
  if (bytes.length < 64 || bytes.toString('ascii', 0, 2) !== 'MZ') throw new Error('Invalid native PE')
  const pe = bytes.readUInt32LE(60)
  if (pe > bytes.length - 24 || bytes.toString('ascii', pe, pe + 4) !== 'PE\0\0'
    || bytes.readUInt16LE(pe + 4) !== (arch === 'x64' ? 0x8664 : 0xaa64)) throw new Error('Wrong native PE architecture')
}

export async function installAgentDesktop(root: string, arch: string = process.arch, fetchArchive: (url: string) => Promise<Buffer> = url => download(url, 0, 80 * 1024 * 1024)): Promise<void> {
  if (!['x64', 'arm64'].includes(arch)) throw new Error('Unsupported Windows native architecture')
  const lock = JSON.parse(await readFile(join(root, 'scripts/agent-desktop-native-lock.json'), 'utf8'))
  const entry = lock.assets[`win32-${arch}`]
  const url = `https://github.com/ci010/shadow-native-deps/releases/download/${agentDesktopRelease}/${agentDesktopRelease}-win32-${arch}.tar.gz`
  if (lock.release !== agentDesktopRelease || lock.sourceRevision !== agentDesktopRevision || entry?.url !== url
    || !/^[a-f0-9]{64}$/.test(entry.sha256) || lock.nativeInputs !== await nativeRecipeFingerprint(root)) throw new Error('Missing or stale pinned agent-desktop native recipe')
  const bytes = await fetchArchive(url)
  verifyArchiveDigest(bytes, entry.sha256)
  const files = unpackAgentDesktopBundle(bytes)
  validateNativePE(files.get('shadow-agent-desktop.node')!, arch)
  const provenance = JSON.parse(files.get('provenance.json')!.toString())
  if (provenance.recipe !== agentDesktopRelease || provenance.upstream !== agentDesktopRevision
    || provenance.commit !== lock.commit || provenance.target !== (arch === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc')) throw new Error('Native provenance mismatch')
  for (const [name, content] of files) {
    if (name !== 'provenance.json' && provenance.files?.[name]?.sha256 !== createHash('sha256').update(content).digest('hex')) throw new Error(`Native inventory mismatch: ${name}`)
  }
  const base = join(root, 'integrations/agent-desktop/artifacts')
  // Refuse symlinked ancestors and unexpected destinations; never extract archive paths.
  for (const dir of [root, join(root, 'integrations'), join(root, 'integrations/agent-desktop')]) {
    if (!(await lstat(dir)).isDirectory()) throw new Error('Unsafe native installation directory')
  }
  await mkdir(base, { recursive: true })
  if (!(await lstat(base)).isDirectory()) throw new Error('Unsafe native artifacts directory')
  const destination = join(base, `win32-${arch}`)
  let existing = false
  try {
    if (!(await lstat(destination)).isDirectory()) throw new Error('Unsafe native destination')
    for (const name of await readdir(destination)) if (![...bundleFiles, 'build-manifest.json'].includes(name) || !(await lstat(join(destination, name))).isFile()) throw new Error(`Unexpected native asset: ${name}`)
    existing = true
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  const stage = await mkdtemp(join(base, '.download-'))
  const output = join(stage, 'new'), backup = join(stage, 'previous')
  let moved = false
  try {
    await mkdir(output)
    for (const [name, content] of files) await writeFile(join(output, name), content)
    if (existing) { await rename(destination, backup); moved = true }
    try { await rename(output, destination); await recordNativeBuild(root, arch, bundleFiles.filter(name => !['shadow-agent-desktop.node', 'shadow-input-guard.exe'].includes(name))) }
    catch (error) {
      await rm(destination, { recursive: true, force: true })
      if (moved) { await rename(backup, destination); moved = false }
      throw error
    }
    moved = false
  } finally { if (!moved) await rm(stage, { recursive: true, force: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await installAgentDesktop(process.cwd(), process.argv[2])
