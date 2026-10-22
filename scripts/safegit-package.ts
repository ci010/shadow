import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { SAFEGIT_ARCHIVES, SAFEGIT_REPOSITORY, SAFEGIT_VERSION, safegitTarget } from '../src/execution/git/safegit.ts'

const exec = promisify(execFile)
export function verifySafegitArchive(bytes: Uint8Array, target: string): void {
  if (!SAFEGIT_ARCHIVES[target]) throw new Error(`Unsupported safegit target: ${target}`)
  if (createHash('sha256').update(bytes).digest('hex') !== SAFEGIT_ARCHIVES[target]) {
    throw new Error('safegit release archive SHA-256 mismatch')
  }
}

/** Pinned fork releases only. No Go toolchain or gh is required/bundled. */
export async function prepareSafegit(root: string, platform: string = process.platform, arch: string = process.arch): Promise<void> {
  const target = safegitTarget(platform, arch)
  if (!target) return // Unsupported platforms fail closed at runtime.
  const binaryName = platform === 'win32' ? 'safegit.exe' : 'safegit'
  const directory = join(root, 'desktop', 'safegit')
  const scratchRoot = join(root, '.tmp')
  await mkdir(scratchRoot, { recursive: true })
  const scratch = await mkdtemp(join(scratchRoot, 'safegit-'))
  const archiveName = `safegit_${SAFEGIT_VERSION}_${target}.tar.gz`
  try {
    const cache = join(scratchRoot, archiveName)
    let bytes: Buffer
    try { bytes = await readFile(cache) } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const response = await fetch(`https://github.com/${SAFEGIT_REPOSITORY}/releases/download/v${SAFEGIT_VERSION}/${archiveName}`,
        { signal: AbortSignal.timeout(180_000) })
      if (!response.ok) throw new Error(`safegit download failed: HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      verifySafegitArchive(bytes, target)
      await writeFile(cache, bytes)
    }
    verifySafegitArchive(bytes, target)
    const archive = join(scratch, archiveName)
    await writeFile(archive, bytes)
    // Extract only named files, never arbitrary release paths.
    await exec('tar', ['-xzf', archiveName, binaryName, 'LICENSE'], { cwd: scratch, timeout: 30_000 })
    await mkdir(directory, { recursive: true })
    await copyFile(join(scratch, binaryName), join(directory, binaryName))
    await copyFile(join(scratch, 'LICENSE'), join(directory, 'LICENSE'))
    await chmod(join(directory, binaryName), 0o755)
    const binarySha256 = createHash('sha256').update(await readFile(join(directory, binaryName))).digest('hex')
    await writeFile(join(directory, 'release.json'), JSON.stringify({ version: SAFEGIT_VERSION, target,
      archive: archiveName, archiveSha256: SAFEGIT_ARCHIVES[target], binarySha256 }, null, 2) + '\n')
  } finally { await rm(scratch, { recursive: true, force: true }) }
  await verifySafegitPackage(root, platform, arch)
}

export async function verifySafegitPackage(root: string, platform: string = process.platform, arch: string = process.arch): Promise<void> {
  const target = safegitTarget(platform, arch)
  if (!target) return
  const binaryName = platform === 'win32' ? 'safegit.exe' : 'safegit'
  const directory = join(root, 'desktop', 'safegit')
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  const binary = await readFile(join(directory, binaryName))
  if (release.version !== SAFEGIT_VERSION || release.target !== target || release.archiveSha256 !== SAFEGIT_ARCHIVES[target]
    || createHash('sha256').update(binary).digest('hex') !== release.binarySha256) throw new Error('Invalid safegit package inventory')
  if (!(await readFile(join(directory, 'LICENSE'), 'utf8')).includes('MIT License')) throw new Error('Missing safegit MIT license')
  const expectedCpu = arch === 'arm64' ? 0x0100000c : 0x01000007
  const peOffset = binary.length >= 64 ? binary.readUInt32LE(60) : 0
  const native = binary.length > 32 && (platform === 'win32'
    ? binary.toString('ascii', 0, 2) === 'MZ' && peOffset >= 64 && peOffset + 6 <= binary.length
      && binary.toString('ascii', peOffset, peOffset + 4) === 'PE\0\0' && binary.readUInt16LE(peOffset + 4) === 0x8664
    : platform === 'linux'
    ? binary.toString('hex', 0, 4) === '7f454c46' && binary[4] === 2 && binary[5] === 1
      && binary.readUInt16LE(18) === (arch === 'arm64' ? 183 : 62)
    : binary.toString('hex', 0, 4) === 'cffaedfe' && binary.readUInt32LE(4) === expectedCpu)
  if (!native) throw new Error('safegit package has the wrong executable format/architecture')
  if (platform === process.platform && arch === process.arch) {
    const { stdout } = await exec(join(directory, binaryName), ['--version'], { timeout: 10_000, maxBuffer: 4096 })
    if (!new RegExp(`(?:^|\\s)${SAFEGIT_VERSION.replaceAll('.', '\\.')}($|\\s)`).test(stdout)) throw new Error('safegit package version mismatch')
  }
}

export async function prepareSafegitSigning(root: string, platform: string = process.platform): Promise<void> {
  if (platform !== 'darwin') return
  const binary = join(root, 'desktop', 'safegit', 'safegit')
  await exec('/usr/bin/codesign', ['--sign', '-', '--force', '--timestamp', '--options', 'runtime',
    '--entitlements', join(root, 'desktop', 'assets', 'entitlements.mac.plist'), binary], { timeout: 30_000 })
  await exec('/usr/bin/codesign', ['--verify', '--strict', binary], { timeout: 30_000 })
  const inventory = join(root, 'desktop', 'safegit', 'release.json')
  const release = JSON.parse(await readFile(inventory, 'utf8'))
  release.binarySha256 = createHash('sha256').update(await readFile(binary)).digest('hex')
  await writeFile(inventory, JSON.stringify(release, null, 2) + '\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await prepareSafegit(process.cwd())
  console.log(safegitTarget() ? 'Pinned safegit prepared and verified.' : 'safegit unsupported on this platform; no binary installed.')
}
