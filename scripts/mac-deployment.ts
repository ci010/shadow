import { execFile, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, openSync } from 'node:fs'
import { cp, lstat, mkdir, readFile, readlink, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { ReleaseReadiness } from '../desktop/src/release-readiness.ts'

const exec = promisify(execFile)
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

export async function acquireReleaseLock(root: string, id: string): Promise<() => Promise<void>> {
  if (!uuid.test(id)) throw new Error('Invalid release ID')
  const path = join(root, 'release.lock')
  try { await mkdir(path, { mode: 0o700 }) } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`Another release is running, or a release was interrupted. Inspect ${path}; stale locks are never removed automatically.`)
    }
    throw error
  }
  await writeFile(join(path, 'owner.json'), JSON.stringify({ id, pid: process.pid }), { flag: 'wx', mode: 0o600 })
  return async () => {
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8'))
    if (owner.id !== id || owner.pid !== process.pid) throw new Error('Release lock ownership changed')
    await rm(join(path, 'owner.json'))
    await rm(path, { recursive: true })
  }
}

export function managedAppProcesses(stdout: string, root: string, application: string): number[] {
  return stdout.split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (!match) return []
    const command = match[2]!
    return (command.startsWith(`${root}/releases/`) && command.includes('/Shadow.app/Contents/')
      || command.startsWith(`${application}/Contents/`)) ? [Number(match[1])] : []
  })
}

export async function requireStopped(root: string, application: string): Promise<void> {
  const { stdout } = await exec('/bin/ps', ['-axo', 'pid=,comm='])
  const pids = managedAppProcesses(stdout, root, application)
  if (pids.length) throw new Error(`Quit Shadow on the Mac before releasing (owned app processes: ${pids.join(', ')}). No process was stopped.`)
}

export async function checkInstallationLink(application: string, current: string): Promise<void> {
  if (!await exists(application)) return
  const info = await lstat(application)
  if (!info.isSymbolicLink() || await readlink(application) !== join(current, 'Shadow.app')) {
    throw new Error(`Refusing to overwrite an unmanaged application: ${application}`)
  }
}

export async function promoteRelease(root: string, id: string, application: string): Promise<void> {
  if (!uuid.test(id)) throw new Error('Invalid release ID')
  const current = join(root, 'current')
  await checkInstallationLink(application, current)
  if (await exists(current) && !(await lstat(current)).isSymbolicLink()) throw new Error('Current release is not a managed symlink')
  if (!await exists(application)) {
    await mkdir(dirname(application), { recursive: true })
    await symlink(join(current, 'Shadow.app'), application)
  }
  const staging = join(root, `current-${id}`)
  await symlink(join('releases', id), staging)
  try { await rename(staging, current) } finally { if (await exists(staging)) await rm(staging) }
}

export function parseReadiness(value: unknown, expected: {
  pid: number; executablePath: string; buildId: string; sourceHash: string
}): ReleaseReadiness {
  if (!value || typeof value !== 'object') throw new Error('Invalid application readiness response')
  const data = value as Record<string, unknown>
  if (data.type !== 'shadow:release-ready' || data.pid !== expected.pid
    || data.executablePath !== expected.executablePath || data.buildId !== expected.buildId || data.sourceHash !== expected.sourceHash
    || (data.state !== 'ready' && data.state !== 'setup-required' && data.state !== 'failed')
    || (data.role !== null && data.role !== 'main' && data.role !== 'child')
    || data.state === 'ready' && data.role === null) {
    throw new Error('Application readiness identity does not match this release')
  }
  if (data.state === 'failed') throw new Error('The new application could not start its saved runtime')
  return { type: 'shadow:release-ready', ...expected, state: data.state, role: data.role }
}

async function launchRelease(executablePath: string, buildId: string, sourceHash: string, logPath: string): Promise<ReleaseReadiness> {
  const output = openSync(logPath, 'a', 0o600)
  const env: NodeJS.ProcessEnv = { ...process.env, SHADOW_DESKTOP_RELEASE_IPC: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.SHADOW_DESKTOP_USER_DATA
  delete env.SHADOW_DESKTOP_DISABLE_AUTO_START
  delete env.SHADOW_SERVICE_CONNECTION
  delete env.VITE_DEV_URL
  let child
  try {
    child = spawn(executablePath, [], { detached: true, env, stdio: ['ignore', output, output, 'ipc'] })
  } finally { closeSync(output) }
  try {
    return await new Promise<ReleaseReadiness>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('New application readiness timed out')), 90_000)
      const finish = (error?: Error, readiness?: ReleaseReadiness) => {
        clearTimeout(timer)
        child.removeListener('message', onMessage)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        if (error) reject(error)
        else resolve(readiness!)
      }
      const onError = (error: Error) => finish(error)
      const onExit = (code: number | null) => finish(new Error(`New application exited before readiness (${code}); another Shadow instance may be using its profile`))
      const onMessage = (value: unknown) => {
        if (!value || typeof value !== 'object' || !('type' in value) || value.type !== 'shadow:release-ready') return
        try { finish(undefined, parseReadiness(value, { pid: child.pid!, executablePath, buildId, sourceHash })) }
        catch (error) { finish(error instanceof Error ? error : new Error(String(error))) }
      }
      child.on('message', onMessage)
      child.once('error', onError)
      child.once('exit', onExit)
    })
  } finally {
    // Disconnecting the release launcher must not own the lifetime of the desktop.
    if (child.connected) child.disconnect()
    child.unref()
  }
}

async function buildCommand(command: string, args: string[], log: string, cwd = process.cwd()): Promise<void> {
  console.info(`[release] ${command} ${args.join(' ')}`)
  const descriptor = openSync(log, 'a', 0o600)
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, args, { cwd, stdio: ['ignore', descriptor, descriptor], shell: false })
      child.once('error', reject)
      child.once('exit', (code, signal) => code === 0 ? resolve()
        : reject(new Error(`${command} failed (${signal ?? code}). Log: ${log}`)))
    })
  } finally { closeSync(descriptor) }
}

async function verifySourceSnapshot(source: string, expected: string): Promise<void> {
  const receipt: unknown = JSON.parse(await readFile(join(source, 'release-source.json'), 'utf8'))
  if (!receipt || typeof receipt !== 'object' || !('version' in receipt) || receipt.version !== 1
    || !('sourceHash' in receipt) || receipt.sourceHash !== expected || !('entries' in receipt) || !Array.isArray(receipt.entries)) {
    throw new Error('Invalid source snapshot receipt')
  }
  for (const entry of receipt.entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string'
      || isAbsolute(entry[0]) || entry[0].split('/').some(part => !part || part === '..' || part === '.')
      || entry[0].includes('\\') || !/^[a-f0-9]{64}$/.test(entry[1])) throw new Error('Invalid source receipt entry')
    const path = join(source, entry[0])
    if (!(await lstat(path)).isFile()
      || createHash('sha256').update(await readFile(path)).digest('hex') !== entry[1]) throw new Error(`Source snapshot changed: ${entry[0]}`)
  }
}

export async function deployMac(root: string, id: string, sourceHash: string, pnpm: string): Promise<void> {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('Mac deployment requires native macOS arm64')
  if (!uuid.test(id) || !/^[a-f0-9]{64}$/.test(sourceHash)) throw new Error('Invalid release identity')
  if (!isAbsolute(root) || !root.startsWith(`${homedir()}/`) || root === homedir() || resolve(root) !== root) throw new Error('Invalid release root')
  const source = join(root, 'builds', id, 'source')
  if (process.cwd() !== source) throw new Error('Release must execute inside its own source snapshot')
  for (let path = source; path !== homedir(); path = dirname(path)) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid?.()) throw new Error(`Unowned or linked deployment directory: ${path}`)
  }
  const marker = JSON.parse(await readFile(join(root, 'managed-release.v1.json'), 'utf8'))
  if (marker.version !== 1 || marker.kind !== 'shadow-mac-release') throw new Error('Invalid deployment root marker')
  const application = join(homedir(), 'Applications', 'Shadow.app')
  const release = join(root, 'releases', id)
  const log = join(root, 'builds', id, 'build.log')
  const unlock = await acquireReleaseLock(root, id)
  let launched = false
  try {
    await checkInstallationLink(application, join(root, 'current'))
    await requireStopped(root, application)
    await verifySourceSnapshot(source, sourceHash)
    const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
    const { stdout: pnpmVersion } = await exec(pnpm, ['--version'])
    if (`pnpm@${pnpmVersion.trim()}` !== manifest.packageManager) throw new Error(`Use ${manifest.packageManager} on the Mac`)
    const [major, minor] = process.versions.node.split('.').map(Number)
    if (major! < 24 || major === 24 && minor! < 15) throw new Error('Mac build needs Node 24.15+')
    await buildCommand(pnpm, ['install', '--frozen-lockfile'], log)
    const { sourceFingerprint, verifyReleaseManifest, parseReleaseManifest } = await import('./release-manifest.ts')
    const { desktopTarget } = await import('./desktop-target.ts')
    const { ARIA2_REVISION, verifyAria2Package } = await import('./aria2-package.ts')
    if (await sourceFingerprint(source) !== sourceHash) throw new Error('Installed snapshot does not match release source')
    const target = desktopTarget()
    const scriptHash = createHash('sha256').update(await readFile(join(source, 'scripts', 'build-aria2-native.sh'))).digest('hex')
    const cache = join(root, 'cache', `aria2-${ARIA2_REVISION}-${scriptHash.slice(0, 16)}`)
    const ariaSource = join(cache, 'source')
    const ariaOutput = join(cache, 'desktop', 'aria2')
    if (!await exists(join(cache, 'ready'))) {
      await mkdir(ariaOutput, { recursive: true })
      await cp(join(source, 'desktop', 'aria2', 'BUILD.md'), join(ariaOutput, 'BUILD.md'))
      if (!await exists(join(ariaSource, '.git'))) {
        await mkdir(ariaSource, { recursive: true })
        await buildCommand('git', ['init', '--quiet', ariaSource], log)
      }
      await buildCommand('git', ['-C', ariaSource, 'fetch', '--quiet', '--depth=1', 'https://github.com/aria2/aria2.git', ARIA2_REVISION], log)
      await buildCommand('git', ['-C', ariaSource, 'checkout', '--quiet', '--detach', ARIA2_REVISION], log)
      await buildCommand('/bin/bash', [join(source, 'scripts', 'build-aria2-native.sh'), ariaSource, ariaOutput], log)
      await verifyAria2Package(cache, target)
      await writeFile(join(cache, 'ready'), `${ARIA2_REVISION}\n`)
    }
    await verifyAria2Package(cache, target)
    for (const name of ['aria2c', 'COPYING', 'LICENSE.OpenSSL', 'aria2-1.37.0-source.tar.gz', 'build-aria2-native.sh']) {
      await cp(join(ariaOutput, name), join(source, 'desktop', 'aria2', name))
    }
    await buildCommand(pnpm, ['typecheck'], log)
    await buildCommand(pnpm, ['test:release'], log)
    await buildCommand(pnpm, ['desktop'], log)
    await buildCommand(pnpm, ['test:packaged'], log)
    await buildCommand(pnpm, ['exec', 'node', '--import', 'tsx', '--test', '--test-concurrency=1',
      'src/execution/processes/*_test.ts', 'src/execution/*_test.ts', 'src/sessions/session-recovery_test.ts'], log)
    await requireStopped(root, application)
    const packaged = join(source, 'desktop', 'release', target.unpackedDirectory)
    await verifyReleaseManifest(packaged, source, target)
    await mkdir(release, { recursive: true })
    const bundle = join(release, 'Shadow.app')
    await rename(packaged, bundle)
    const built = parseReleaseManifest(JSON.parse(await readFile(join(bundle, target.resourcesRelativePath, 'release-manifest.v1.json'), 'utf8')))
    const identity = { version: 1, id, sourceHash, buildId: built.buildId, packageVersion: built.packageVersion, createdAt: new Date().toISOString() }
    await writeFile(join(release, 'release.json'), JSON.stringify({ ...identity, state: 'staged' }) + '\n', { flag: 'wx' })
    const profile = join(root, 'profile-main')
    await mkdir(profile, { recursive: true, mode: 0o700 })
    const profileInfo = await lstat(profile)
    if (!profileInfo.isDirectory() || profileInfo.isSymbolicLink() || profileInfo.uid !== process.getuid?.()
      || (profileInfo.mode & 0o077) !== 0) throw new Error('Daily Main profile must be a private owned directory')
    await writeFile(join(release, 'desktop-deployment.v1.json'),
      JSON.stringify({ version: 1, role: 'main', userDataPath: profile }) + '\n', { mode: 0o600, flag: 'wx' })
    await checkInstallationLink(application, join(root, 'current'))
    await requireStopped(root, application)
    launched = true
    const readiness = await launchRelease(join(bundle, target.executableRelativePath), built.buildId, sourceHash, join(release, 'application.log'))
    if (readiness.role !== 'main') throw new Error('Daily release started with an unexpected role; the previous installation was not promoted')
    await promoteRelease(root, id, application)
    await writeFile(join(release, 'release.json'), JSON.stringify({ ...identity, state: readiness.state, role: readiness.role, pid: readiness.pid }) + '\n')
    console.info(`[release] ${readiness.state}: ${application}; build ${built.buildId}; source ${sourceHash}`)
    if (readiness.state === 'setup-required') console.info('[release] Complete Main setup on the Mac. The separate daily Main profile contains no imported test credentials or pairings.')
    else console.info('[release] Renderer and local runtime are ready. External providers and remote node connectivity are not certified by this check.')
  } catch (error) {
    if (await exists(release)) await writeFile(join(release, 'failure.json'), JSON.stringify({
      id, sourceHash, launched, failedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error),
    }) + '\n')
    if (launched) console.error('[release] New app may still be running. Quit it before retrying. No process was killed, no old app was restarted, and no user data was rolled back. Previous versions remain under releases/.')
    throw error
  } finally { await unlock() }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) throw new Error('Internal usage: mac-deployment.ts <root> <id> <sourceHash> <pnpm>')
  await deployMac(process.argv[2]!, process.argv[3]!, process.argv[4]!, process.argv[5]!)
}
