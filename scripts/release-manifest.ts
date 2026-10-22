import { createHash, randomUUID } from 'node:crypto'
import { readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { extractFile, listPackage } from '@electron/asar'
import { desktopTarget, type DesktopTarget } from './desktop-target.ts'

const sourceInputs = [
  'src', 'scripts', 'integrations/a2a', 'app/src', 'app/public', 'desktop/src', 'desktop/assets', 'desktop/service', 'desktop/aria2', 'desktop/safegit',
  'build.ts', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.pnpmfile.cjs',
  '.gitattributes', '.github/workflows/release-check.yml',
  'tsconfig.json', 'tsconfig.build.json', 'app/package.json', 'app/tsconfig.json',
  'app/index.html', 'app/vite.config.ts', 'app/unocss.config.ts',
  'desktop/package.json', 'desktop/tsconfig.json', 'desktop/tsconfig.build.json',
  'mobile/package.json', 'mobile/capacitor.config.ts',
]

export interface ReleaseManifest {
  version: 1 | 2
  platform: DesktopTarget['platform']
  arch: DesktopTarget['arch']
  buildId: string
  sourceHash: string
  packageVersion: string
  electronVersion: string
  files: Record<string, string>
}

function hash(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

async function exists(path: string): Promise<boolean> {
  try { await stat(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function tree(directory: string, excluded: ReadonlySet<string> = new Set()): Promise<Map<string, Buffer>> {
  const result = new Map<string, Buffer>()
  const boundary = await realpath(directory)
  async function visit(path: string, ancestors: Set<string>): Promise<void> {
    const actual = await realpath(path)
    const inside = relative(boundary, actual)
    if (inside.startsWith(`..${sep}`) || inside === '..' || isAbsolute(inside)) {
      throw new Error(`Release input escapes its root: ${path}`)
    }
    const info = await stat(path)
    if (info.isDirectory()) {
      if (ancestors.has(actual)) throw new Error(`Cyclic release input: ${path}`)
      const next = new Set(ancestors).add(actual)
      for (const name of (await readdir(path)).sort()) {
        if (!excluded.has(name)) await visit(join(path, name), next)
      }
    } else if (info.isFile()) {
      result.set(relative(directory, path).split(sep).join('/'), await readFile(path))
    } else {
      throw new Error(`Unsupported release input: ${path}`)
    }
  }
  await visit(directory, new Set())
  return result
}

export async function directoryFingerprint(directory: string): Promise<string> {
  return hash(JSON.stringify([...await tree(directory)].map(([name, bytes]) => [name, hash(bytes)])))
}

export async function sourceFingerprint(root: string): Promise<string> {
  const entries: Array<[string, string]> = []
  for (const input of sourceInputs) {
    const path = resolve(root, input)
    if (!await exists(path)) continue
    if ((await stat(path)).isDirectory()) {
      for (const [name, bytes] of await tree(path, input === 'integrations/a2a' ? new Set(['node_modules', 'dist']) : undefined)) {
        // The pinned downloaded wrapper is an output, not source.
        if (input === 'desktop/service' && name === 'ShadowService.exe') continue
        if (input === 'desktop/safegit' && ['safegit', 'release.json', 'LICENSE'].includes(name)) continue
        if (input === 'desktop/aria2' && ['aria2c', 'aria2c.exe', 'COPYING', 'LICENSE.OpenSSL',
          'aria2-1.37.0-source.tar.gz', 'build-aria2-native.sh'].includes(name)) continue
        entries.push([`${input}/${name}`, hash(bytes)])
      }
    } else {
      entries.push([input, hash(await readFile(path))])
    }
  }
  return hash(JSON.stringify(entries.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))
}

export async function createReleaseManifest(
  root: string, expectedSourceHash: string, target: DesktopTarget = desktopTarget(),
): Promise<ReleaseManifest> {
  const sourceHash = await sourceFingerprint(root)
  if (sourceHash !== expectedSourceHash) throw new Error('Source changed during release validation; rebuild before packaging.')
  const manifest = JSON.parse(await readFile(join(root, 'desktop', 'package.json'), 'utf8'))
  const files: Record<string, string> = {}
  for (const [input, prefix] of [
    ['desktop/backend', 'resources/backend'],
    ['app/dist', 'resources/app-dist'],
    ['desktop/aria2', 'resources/aria2'],
    ...(target.platform !== 'win32' && await exists(join(root, 'desktop', 'safegit', 'release.json'))
      ? [['desktop/safegit', 'resources/safegit']] : []),
    ...(target.platform === 'win32' ? [['desktop/service', 'resources/service']] : []),
    ['desktop/dist', 'asar/dist'],
    ['desktop/assets', 'asar/assets'],
  ]) {
    for (const [name, bytes] of await tree(resolve(root, input))) {
      if (prefix === 'resources/aria2' && ['aria2c', 'aria2c.exe'].includes(name)
        && name !== (target.platform === 'win32' ? 'aria2c.exe' : 'aria2c')) continue
      if (prefix === 'resources/safegit' && !['safegit', 'LICENSE', 'release.json'].includes(name)) continue
      if (prefix === 'resources/backend' && !name.startsWith('dist/') && !name.startsWith('node_modules/') && name !== 'package.json') continue
      if (prefix === 'resources/backend' && name.startsWith('dist/') && name.endsWith('.map')) continue
      // electron-builder removes Git directory placeholders from extraResources.
      if (prefix === 'resources/backend' && name.startsWith('node_modules/') && name.endsWith('/.gitkeep')) continue
      if (prefix === 'asar/dist' && !/\.(?:js|cjs)$/.test(name)) continue
      files[`${prefix}/${name}`] = hash(bytes)
    }
  }
  const result: ReleaseManifest = {
    version: 2, platform: target.platform, arch: target.arch, buildId: randomUUID(), sourceHash,
    packageVersion: manifest.version, electronVersion: manifest.devDependencies.electron, files,
  }
  parseReleaseManifest(result)
  // Keep the resource filename stable; the schema version and target are in the document.
  await writeFile(join(root, 'desktop', 'release-manifest.v1.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

export function parseReleaseManifest(value: unknown): ReleaseManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release manifest')
  const data = value as Record<string, unknown>
  const hex = (item: unknown): item is string => typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
  const legacy = data.version === 1
  const normalizedLegacy = legacy && Object.keys(data).length === 8
    && data.platform === 'win32' && data.arch === 'x64'
  if ((legacy ? Object.keys(data).length !== 6 && !normalizedLegacy : Object.keys(data).length !== 8)
    || (!legacy && data.version !== 2) || typeof data.buildId !== 'string' ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(data.buildId) ||
    !hex(data.sourceHash) || typeof data.packageVersion !== 'string' ||
    typeof data.electronVersion !== 'string' || !data.files || typeof data.files !== 'object' || Array.isArray(data.files)) {
    throw new Error('Invalid release manifest')
  }
  if (!legacy && (typeof data.platform !== 'string' || typeof data.arch !== 'string')) throw new Error('Invalid release manifest target')
  const target = legacy ? desktopTarget('win32', 'x64') : desktopTarget(data.platform as string, data.arch as string)
  const files: Record<string, string> = {}
  for (const [name, checksum] of Object.entries(data.files)) {
    if (!/^(resources\/(?:backend|app-dist|service|aria2|safegit)|asar\/(?:dist|assets))\//.test(name) ||
      name.includes('\\') || name.split('/').some(part => part === '.' || part === '..' || !part) || !hex(checksum)) {
      throw new Error(`Invalid release manifest entry: ${name}`)
    }
    files[name] = checksum
  }
  if (target.platform !== 'win32' && Object.keys(files).some(name => name.startsWith('resources/service/'))) {
    throw new Error('Non-Windows release manifest must not contain service resources')
  }
  for (const required of ['resources/backend/dist/src/index.js', 'resources/app-dist/index.html',
    ...(legacy ? [] : [`resources/aria2/${target.platform === 'win32' ? 'aria2c.exe' : 'aria2c'}`,
      'resources/aria2/COPYING', 'resources/aria2/LICENSE.OpenSSL',
      'resources/aria2/aria2-1.37.0-source.tar.gz', 'resources/aria2/BUILD.md', 'resources/aria2/build-aria2-native.sh']),
    ...(target.platform === 'win32' ? ['resources/service/ShadowService.exe'] : []),
    'asar/dist/main.js', 'asar/dist/preload.cjs']) {
    if (!(required in files)) throw new Error(`Release manifest is missing ${required}`)
  }
  return {
    version: legacy ? 1 : 2, platform: target.platform, arch: target.arch, buildId: data.buildId, sourceHash: data.sourceHash,
    packageVersion: data.packageVersion, electronVersion: data.electronVersion, files,
  }
}

export async function verifyReleaseManifest(
  packagedRoot: string, repositoryRoot: string | undefined, target: DesktopTarget = desktopTarget(),
): Promise<void> {
  const resources = join(packagedRoot, target.resourcesRelativePath)
  const saved: unknown = JSON.parse(await readFile(join(resources, 'release-manifest.v1.json'), 'utf8'))
  const manifest = parseReleaseManifest(saved)
  const legacy = typeof saved === 'object' && saved !== null && 'version' in saved && saved.version === 1
  if (manifest.platform !== target.platform || manifest.arch !== target.arch) {
    throw new Error(`Packaged application target ${manifest.platform}/${manifest.arch} does not match ${target.platform}/${target.arch}`)
  }
  if (repositoryRoot !== undefined) {
    if (manifest.sourceHash !== await sourceFingerprint(repositoryRoot)) {
      throw new Error('Packaged application does not match current source. Run pnpm desktop to create a fresh release.')
    }
    const desktopPackage = JSON.parse(await readFile(join(repositoryRoot, 'desktop', 'package.json'), 'utf8'))
    if (manifest.packageVersion !== desktopPackage.version || manifest.electronVersion !== desktopPackage.devDependencies.electron) {
      throw new Error('Packaged application version does not match the release configuration')
    }
  }
  const archive = join(resources, 'app.asar')
  const packagedManifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
  if (packagedManifest.version !== manifest.packageVersion || packagedManifest.main !== 'dist/main.js') {
    throw new Error('Packaged Electron entry or version does not match the release configuration')
  }
  const actual = new Map<string, Buffer>()
  if (target.platform !== 'win32' && (await readdir(resources)).includes('service')) {
    throw new Error('Non-Windows package must not contain service resources')
  }
  for (const directory of ['backend', 'app-dist', ...(!legacy ? ['aria2'] : []),
    ...(Object.keys(manifest.files).some(name => name.startsWith('resources/safegit/')) ? ['safegit'] : []),
    ...(target.platform === 'win32' ? ['service'] : [])]) {
    for (const [name, bytes] of await tree(join(resources, directory))) {
      actual.set(`resources/${directory}/${name}`, bytes)
    }
  }
  const archiveEntries = listPackage(archive, { isPack: false }).map(name => name.replaceAll('\\', '/').replace(/^\//, ''))
  for (const name of archiveEntries) {
    if (!name.startsWith('dist/') && !name.startsWith('assets/')) continue
    if (archiveEntries.some(other => other.startsWith(`${name}/`))) continue
    actual.set(`asar/${name}`, extractFile(archive, name.split('/').join(sep)))
  }
  if (actual.size !== Object.keys(manifest.files).length) throw new Error('Packaged file inventory differs from validated build inputs')
  for (const [name, checksum] of Object.entries(manifest.files)) {
    const bytes = actual.get(name)
    if (!bytes || hash(bytes) !== checksum) throw new Error(`Packaged file differs from validated build: ${name}`)
  }
}
