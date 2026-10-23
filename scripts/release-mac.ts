import { execFile, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { pipeline } from 'node:stream/promises'
import { sourceFingerprint } from './release-manifest.ts'

const exec = promisify(execFile)
const directories = new Set(['src', 'scripts', 'app', 'desktop', 'mobile', 'integrations', 'docs', '.github'])
const rootFiles = new Set([
  'README.md', 'AGENTS.md', 'LICENSE', 'LICENSE.md', 'build.ts', 'package.json', 'pnpm-lock.yaml',
  'pnpm-workspace.yaml', '.pnpmfile.cjs', '.gitattributes', '.gitignore',
  'tsconfig.json', 'tsconfig.build.json', 'bot.config.example.json',
])

export interface MacReleaseConfig {
  host: string
  identityFile?: string
  remoteRoot: string
  remoteNode: string
  remotePnpm: string
  remotePath: string
}

export function parseMacReleaseConfig(value: unknown): MacReleaseConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Mac release configuration')
  const data = value as Record<string, unknown>
  const keys = ['host', 'identityFile', 'remoteRoot', 'remoteNode', 'remotePnpm', 'remotePath']
  if (Object.keys(data).some(key => !keys.includes(key))
    || typeof data.host !== 'string' || !/^[a-zA-Z0-9_.-]+@[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(data.host)) {
    throw new Error('Mac release host must be user@hostname (or an IPv4 address)')
  }
  const macPath = (key: 'remoteRoot' | 'remoteNode' | 'remotePnpm'): string => {
    const value = data[key]
    if (typeof value !== 'string' || (!/^\/Users\/[^/]+\/.+/.test(value)
      && (key === 'remoteRoot' || !/^\/(?:opt|usr)\/.+/.test(value)))
      || /[\u0000-\u001f]/u.test(value) || posix.normalize(value) !== value || value.split('/').includes('..')) {
      throw new Error(`${key} must be an absolute Mac path; remoteRoot must be below /Users/<user>`)
    }
    return value
  }
  const remoteRoot = macPath('remoteRoot'), remoteNode = macPath('remoteNode'), remotePnpm = macPath('remotePnpm')
  if (typeof data.remotePath !== 'string' || !data.remotePath
    || data.remotePath.split(':').some(path => !path.startsWith('/') || /[\u0000-\u001f]/u.test(path))) {
    throw new Error('remotePath must contain only absolute PATH entries')
  }
  if (data.identityFile !== undefined && (typeof data.identityFile !== 'string'
    || !isAbsolute(data.identityFile) || /[\u0000-\u001f]/u.test(data.identityFile))) {
    throw new Error('identityFile must be an absolute local path; SSH agent/config is also supported')
  }
  return { host: data.host, remoteRoot, remoteNode, remotePnpm, remotePath: data.remotePath,
    ...(typeof data.identityFile === 'string' ? { identityFile: data.identityFile } : {}) }
}

export function shellQuote(value: string): string {
  if (/[\u0000-\u001f]/u.test(value)) throw new Error('Control characters are not allowed in SSH arguments')
  return `'${value.replaceAll("'", "'\\''")}'`
}

export async function assertPrivateReleaseConfig(root: string, path: string): Promise<void> {
  const local = relative(resolve(root), resolve(path))
  if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) return
  const sourcePath = local.split(sep).join('/')
  if (directories.has(sourcePath.split('/')[0]!) || isReleaseSource(sourcePath)) {
    throw new Error('Keep private deployment configuration outside release source directories')
  }
  try {
    await exec('git', ['check-ignore', '--quiet', '--', local], { cwd: root })
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 1) {
      throw new Error('Deployment configuration inside the repository must be Git-ignored and untracked; use .shadow-release.json')
    }
    throw error
  }
}

export function isReleaseSource(path: string): boolean {
  const parts = path.split('/')
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes('\\')
    || /[\u0000-\u001f]/u.test(part))) return false
  if (parts.length === 1) return rootFiles.has(path)
  if (!directories.has(parts[0]!)) return false
  if (parts.some(part => ['node_modules', 'workspace', '.tmp', '.git', 'dist', 'dist-mobile', 'release'].includes(part)
    || part.startsWith('.env') || part === 'bot.config.json' || part.endsWith('.credential')
    || /\.(?:pem|key|p12|pfx)$/i.test(part))) return false
  return !path.startsWith('desktop/backend/') && !path.startsWith('mobile/android/.gradle/')
    && !path.startsWith('mobile/android/app/build/') && !path.startsWith('mobile/ios/App/Pods/')
    && !path.startsWith('mobile/ios/App/build/')
    && !/^desktop\/aria2\/(?:aria2c(?:\.exe)?|COPYING|LICENSE\.OpenSSL|aria2-1\.37\.0-source\.tar\.gz|build-aria2-native\.sh)$/.test(path)
    && path !== 'desktop/service/ShadowService.exe' && path !== 'desktop/release-manifest.v1.json'
}

export async function snapshotReleaseSource(root: string, destination: string): Promise<string> {
  const list = async () => {
    const { stdout } = await exec('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: root, maxBuffer: 16 * 1024 * 1024,
    })
    return [...new Set(stdout.split('\0').filter(isReleaseSource))].sort()
  }
  const paths = await list()
  const entries: Array<[string, string]> = []
  for (const path of paths) {
    const source = join(root, path)
    let info
    try { info = await lstat(source) } catch (error) {
      if (isMissing(error)) continue
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Source must be a regular file: ${path}`)
    const bytes = await readFile(source)
    const target = join(destination, path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes, { mode: info.mode, flag: 'wx' })
    entries.push([path, createHash('sha256').update(bytes).digest('hex')])
  }
  for (const [path, checksum] of entries) {
    if (createHash('sha256').update(await readFile(join(root, path))).digest('hex') !== checksum) {
      throw new Error(`Source changed during release snapshot: ${path}`)
    }
  }
  if (JSON.stringify(paths) !== JSON.stringify(await list())) throw new Error('Source inventory changed during snapshot')
  const sourceHash = await sourceFingerprint(destination)
  if (sourceHash !== await sourceFingerprint(root)) throw new Error('Release snapshot is incomplete or source changed')
  await writeFile(join(destination, 'release-source.json'), JSON.stringify({ version: 1, sourceHash, entries }) + '\n', { flag: 'wx' })
  return sourceHash
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function run(command: string, args: string[], inputFile?: string): Promise<void> {
  const child = spawn(command, args, { stdio: [inputFile ? 'pipe' : 'ignore', 'inherit', 'inherit'], shell: false })
  const completion = new Promise<void>((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? resolve()
      : reject(new Error(`${command} failed (${signal ?? code})`)))
  })
  const input = inputFile ? pipeline(createReadStream(inputFile), child.stdin!) : Promise.resolve()
  await Promise.all([completion, input])
}

export async function releaseMac(root: string, config: MacReleaseConfig): Promise<void> {
  const id = randomUUID()
  const local = join(root, '.tmp', 'mac-release', id)
  const source = join(local, 'source')
  const archive = join(local, 'source.tar.gz')
  const remote = `${config.remoteRoot}/builds/${id}`
  const ssh = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    ...(config.identityFile ? ['-i', config.identityFile, '-o', 'IdentitiesOnly=yes'] : []), config.host]
  const environment = `export PATH=${shellQuote(config.remotePath)}; `
  // The bootstrap only creates fresh staging directories, never alters a running installation.
  const bootstrap = `
    const fs = require('node:fs'); const os = require('node:os'); const p = require('node:path');
    const root = process.argv[1], stage = process.argv[2];
    if (process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('Requires a native Apple Silicon Mac');
    if (!root.startsWith(os.homedir() + '/') || root === os.homedir()) throw Error('Release root must be below SSH user home');
    for (let at = root; at !== p.dirname(at); at = p.dirname(at)) {
      if (fs.existsSync(at) && fs.lstatSync(at).isSymbolicLink()) throw Error('Release root must not use symlinks');
    }
    fs.mkdirSync(root, {recursive:true, mode:0o700});
    const marker = p.join(root, 'managed-release.v1.json');
    if (!fs.existsSync(marker)) {
      if (fs.readdirSync(root).length) throw Error('Refusing to adopt a nonempty release directory');
      fs.writeFileSync(marker, JSON.stringify({version:1,kind:'shadow-mac-release'}), {flag:'wx',mode:0o600});
    }
    if (fs.readFileSync(marker,'utf8') !== JSON.stringify({version:1,kind:'shadow-mac-release'})) throw Error('Invalid release root marker');
    const uid = require('node:child_process').execFileSync('/usr/bin/stat',['-f','%u','/dev/console'],{encoding:'utf8'}).trim();
    if (uid !== String(process.getuid())) throw Error('Log into the Mac graphical session as the SSH user first');
    fs.mkdirSync(p.dirname(stage),{recursive:true,mode:0o700});
    fs.mkdirSync(stage,{mode:0o700});
  `.replaceAll('\n', ' ')
  await run('ssh', [...ssh, environment + `${shellQuote(config.remoteNode)} -e ${shellQuote(bootstrap)} ${shellQuote(config.remoteRoot)} ${shellQuote(remote)} && ${shellQuote(config.remotePnpm)} --version`])
  console.info(`[release] Snapshot ${id}: current working source, including uncommitted changes`)
  const sourceHash = await snapshotReleaseSource(root, source)
  await run('tar', ['-czf', archive, '-C', source, '.'])
  const checksum = createHash('sha256')
  for await (const chunk of createReadStream(archive)) checksum.update(chunk)
  const archiveHash = checksum.digest('hex')
  await run('ssh', [...ssh, `umask 077; set -C; cat > ${shellQuote(`${remote}/source.tar.gz`)}`], archive)
  const verify = `const f=require('node:fs');const c=require('node:crypto');const b=f.readFileSync(process.argv[1]);if(c.createHash('sha256').update(b).digest('hex')!==process.argv[2])throw Error('Source archive checksum mismatch');`
  const command = environment
    + `${shellQuote(config.remoteNode)} -e ${shellQuote(verify)} ${shellQuote(`${remote}/source.tar.gz`)} ${shellQuote(archiveHash)}`
    + ` && mkdir ${shellQuote(`${remote}/source`)} && tar -xzf ${shellQuote(`${remote}/source.tar.gz`)} -C ${shellQuote(`${remote}/source`)}`
    + ` && cd ${shellQuote(`${remote}/source`)} && ${shellQuote(config.remoteNode)} scripts/mac-deployment.ts`
    + ` ${shellQuote(config.remoteRoot)} ${shellQuote(id)} ${shellQuote(sourceHash)} ${shellQuote(config.remotePnpm)}`
  console.info(`[release] Building ${sourceHash} natively on ${config.host}; log: ${remote}/build.log`)
  await run('ssh', [...ssh, command])
  await writeFile(join(local, 'release.json'), JSON.stringify({ id, sourceHash, host: config.host, remoteRoot: config.remoteRoot }) + '\n')
  await rm(source, { recursive: true })
  console.info(`[release] Deployed ${id}. Source archive retained at ${archive}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(arg => arg !== '--')
  if (args[0] === '--help') {
    console.info('Usage: pnpm release [--config <file>]\nDefault: .shadow-release.json. Quit Shadow on the Mac before releasing. No GitHub Release is created.')
  } else {
    if (args.length && (args.length !== 2 || args[0] !== '--config')) throw new Error('Usage: pnpm release [--config <file>]')
    const path = resolve(args[1] ?? '.shadow-release.json')
    await assertPrivateReleaseConfig(process.cwd(), path)
    const config = parseMacReleaseConfig(JSON.parse(await readFile(path, 'utf8')))
    await releaseMac(process.cwd(), config)
  }
}
