import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { link, lstat, open, realpath, rm, stat, statfs } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'
import { localProxyConfiguration, resolveProxyForUrl } from '../execution/network/proxy.ts'

export const ARIA2_VERSION = '1.37.0'
const sha256 = z.string().regex(/^[a-fA-F0-9]{64}$/)
const execFileAsync = promisify(execFile)
const activeDestinations = new Set<string>()
export const downloadSchema = z.object({
  url: z.string().url(),
  directory: z.string().min(1),
  filename: z.string().min(1).max(200),
  sha256,
  bytes: z.number().int().positive().safe().optional(),
  approved: z.literal(true),
}).strict()
export type DownloadRequest = z.input<typeof downloadSchema>

export function releaseBinary(moduleUrl: string = import.meta.url): string {
  const executable = process.platform === 'win32' ? 'aria2c.exe' : 'aria2c'
  return join(dirname(fileURLToPath(moduleUrl)), '..', '..', '..', '..', 'aria2', executable)
}

export function requestedBinary(moduleUrl: string = import.meta.url, override = process.env.SHADOW_ARIA2C_PATH): string {
  if (override) {
    if (!isAbsolute(override)) throw new TypeError('SHADOW_ARIA2C_PATH must be absolute')
    return override
  }
  const modulePath = fileURLToPath(moduleUrl)
  const root = resolve(dirname(modulePath), '..', '..', extname(modulePath) === '.ts' ? '.' : '..')
  if (existsSync(join(root, 'pnpm-workspace.yaml')) && existsSync(join(root, 'scripts', 'desktop.ts'))) {
    return join(root, 'desktop', 'aria2', process.platform === 'win32' ? 'aria2c.exe' : 'aria2c')
  }
  return releaseBinary(moduleUrl)
}

function validateUrl(value: string): void {
  if (/[\u0000-\u0020\u007f]/.test(value)) {
    throw new TypeError('Download URL must not contain whitespace or control characters')
  }
  const url = new URL(value)
  const host = url.hostname.replace(/\.$/, '')
  if (url.protocol !== 'https:' || url.username || url.password || url.hash
    || host === 'localhost' || host.endsWith('.localhost')
    || /^127\./.test(host) || host === '[::1]') {
    throw new TypeError('Downloads require an HTTPS URL without embedded credentials or a loopback host')
  }
}

function validateTarget(directory: string, filename: string): string {
  if (!isAbsolute(directory) || parse(resolve(directory)).root === resolve(directory)) {
    throw new TypeError('Download destination must be a bounded absolute directory')
  }
  if (filename === '.' || filename === '..' || /^\s/.test(filename) || /[/\\:\0-\x1f\x7f]/.test(filename)
    || filename.endsWith('.') || filename.endsWith(' ')
    || /\.(?:shadow-part|shadow-part\.aria2)$/i.test(filename)
    || /\.(?:torrent|metalink|meta4)$/i.test(filename)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(filename)) {
    throw new TypeError('Download filename must be a safe single file name')
  }
  return join(directory, filename)
}

async function existingFile(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false
    throw error
  }
}

async function digest(path: string): Promise<string> {
  const hash = createHash('sha256')
  const file = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(1024 * 1024)
    let offset = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, offset)
      if (!bytesRead) break
      hash.update(buffer.subarray(0, bytesRead))
      offset += bytesRead
    }
  } finally {
    await file.close()
  }
  return hash.digest('hex')
}

export async function runAria2(binary: string, args: string[], signal?: AbortSignal, input?: string): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolveRun, reject) => {
    let processError: Error | undefined
    let diagnostics = ''
    const child = spawn(binary, args, {
      shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'], signal,
    })
    // Parse only bounded diagnostic categories: aria2 output may contain signed URLs.
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (bytes: Buffer) => {
      diagnostics = (diagnostics + bytes.toString('utf8')).slice(-16_384)
    })
    child.once('error', error => { processError = error })
    if (input !== undefined) {
      const stdin = child.stdin
      if (!stdin) {
        processError = new Error('aria2c stdin is unavailable')
        child.kill()
      } else {
        stdin.on('error', error => { processError ??= error; child.kill() })
        stdin.end(input)
      }
    }
    child.once('close', code => {
      if (processError) reject(processError)
      else if (code === 0) resolveRun()
      else {
        const reason = /SSL\/TLS handshake|certificate verification|certificate.*not trusted/i.test(diagnostics)
          ? 'TLS handshake or certificate verification failed. Do not disable certificate checks; check the network and TLS trust configuration.'
          : /name resolution|could not resolve|failed to resolve/i.test(diagnostics)
          ? 'DNS resolution failed. Check name resolution for the approved source.'
          : /timeout|timed out/i.test(diagnostics)
          ? 'The connection or transfer timed out. Check the approved source and network before resuming.'
          : /not enough disk|insufficient disk|no space left|disk.*full/i.test(diagnostics)
          ? 'Insufficient destination disk space.'
          : /status=40[134]|status=50[0234]|HTTP.*(?:401|403|404|500|502|503|504)/i.test(diagnostics)
          ? 'The source returned an HTTP error. Recheck source availability and authorization.'
          : 'Inspect the approved source, network and available disk space.'
        reject(new Error(`aria2c exited ${code}: ${reason} Any partial data is retained for an explicit resume.`))
      }
    })
  })
}

export class Aria2Downloader {
  constructor(
    private readonly run: typeof runAria2 = runAria2,
    private readonly binaryPath: () => string = requestedBinary,
    private readonly version: (binary: string) => Promise<string> = async binary =>
      (await execFileAsync(binary, ['--version'], {
        timeout: 10_000, maxBuffer: 4096, windowsHide: true,
      })).stdout,
    private readonly proxy: (url: string, signal?: AbortSignal) => Promise<string | undefined> = async (url, signal) =>
      resolveProxyForUrl(await localProxyConfiguration(signal), url, signal),
  ) {}

  async binary(): Promise<string> {
    const binary = this.binaryPath()
    const file = await stat(binary).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Pinned aria2c ${ARIA2_VERSION} is missing: ${binary}. For local development, place the trusted binary in desktop/aria2 or set an absolute SHADOW_ARIA2C_PATH. For an installed app, repair the package; do not substitute a PATH binary.`)
      }
      throw error
    })
    if (!file.isFile()) throw new TypeError(`aria2c is not a file: ${binary}`)
    return binary
  }

  async status(): Promise<{ binary: string; version: string }> {
    const binary = await this.binary()
    const stdout = await this.version(binary)
    if (!new RegExp(`^aria2 version ${ARIA2_VERSION.replaceAll('.', '\\.')}\\r?\\n`).test(stdout)) {
      throw new Error(`aria2c must be version ${ARIA2_VERSION}`)
    }
    return { binary, version: ARIA2_VERSION }
  }

  async download(request: DownloadRequest, signal?: AbortSignal): Promise<{ path: string; bytes: number; sha256: string; reused: boolean }> {
    const input = downloadSchema.parse(request)
    validateUrl(input.url)
    validateTarget(input.directory, input.filename)
    const parent = await stat(input.directory)
    if (!parent.isDirectory()) throw new TypeError('Download destination is not a directory')
    const directory = await realpath(input.directory)
    const target = join(directory, input.filename)
    const key = process.platform === 'win32' ? target.toLowerCase() : target
    if (activeDestinations.has(key)) throw new Error('A download to this file is already running')
    activeDestinations.add(key)
    try {
      const expectedHash = input.sha256.toLowerCase()
      if (await existingFile(target)) {
        const file = await lstat(target)
        if (!file.isFile() || (input.bytes && file.size !== input.bytes) || await digest(target) !== expectedHash) {
          throw new Error(`A different file already exists at ${target}; refusing to overwrite it`)
        }
        return { path: target, bytes: file.size, sha256: expectedHash, reused: true }
      }
      const { binary } = await this.status()
      const stage = `${input.filename}.shadow-part`
      const partial = join(directory, stage)
      for (const path of [partial, `${partial}.aria2`]) {
        let info
        try { info = await lstat(path) } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue
          throw error
        }
        if (!info.isFile()) throw new TypeError(`Download partial is not a regular file: ${path}`)
      }
      const remaining = input.bytes ? input.bytes - ((await existingFile(partial)) ? (await lstat(partial)).size : 0) : undefined
      if (remaining !== undefined) {
        if (remaining < 0) throw new Error('Partial download exceeds expected file size')
        const free = await statfs(directory)
        if (BigInt(remaining) > BigInt(free.bavail) * BigInt(free.bsize)) {
          throw new Error('Insufficient disk space for the requested download')
        }
      }
      signal?.throwIfAborted()
      const proxy = await this.proxy(input.url, signal)
      await this.run(binary, [
        '--no-conf=true', '--enable-rpc=false',
        '--http-proxy=', '--https-proxy=', '--all-proxy=',
        '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=false',
        '--max-connection-per-server=4', '--split=4', '--min-split-size=16M',
        '--max-tries=5', '--retry-wait=5', '--connect-timeout=30', '--timeout=30',
        '--summary-interval=0', '--console-log-level=error',
        `--dir=${directory}`, '--input-file=-',
      ], signal, `${input.url}\n  out=${stage}\n${proxy ? `  all-proxy=${proxy}\n` : ''}`)
      const result = await lstat(partial)
      if (!result.isFile() || (input.bytes && result.size !== input.bytes) || await digest(partial) !== expectedHash) {
        await rm(partial, { force: true })
        await rm(`${partial}.aria2`, { force: true })
        throw new Error('Downloaded file failed its expected length or SHA-256; partial data was removed')
      }
      if (await existingFile(target)) throw new Error(`Destination appeared during download: ${target}`)
      await link(partial, target)
      await rm(partial)
      await rm(`${partial}.aria2`, { force: true })
      return { path: target, bytes: result.size, sha256: expectedHash, reused: false }
    } finally {
      activeDestinations.delete(key)
    }
  }
}
