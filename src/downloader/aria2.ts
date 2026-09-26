import { createHash } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { link, lstat, open, realpath, rm, stat, statfs } from 'node:fs/promises'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { z } from 'zod'

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

function requestedBinary(): string {
  const override = process.env.SHADOW_ARIA2C_PATH
  if (override) {
    if (!isAbsolute(override)) throw new TypeError('SHADOW_ARIA2C_PATH must be absolute')
    return override
  }
  return releaseBinary()
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
    const child = spawn(binary, args, {
      shell: false, windowsHide: true, stdio: [input === undefined ? 'ignore' : 'pipe', 'ignore', 'ignore'], signal,
    })
    child.once('error', reject)
    if (input !== undefined) {
      const stdin = child.stdin
      if (!stdin) {
        child.kill()
        reject(new Error('aria2c stdin is unavailable'))
        return
      }
      stdin.on('error', reject)
      stdin.end(input)
    }
    child.once('close', code => {
      if (code === 0) resolveRun()
      else reject(new Error(`aria2c exited ${code}; inspect the download URL, network and available disk space`))
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
  ) {}

  async binary(): Promise<string> {
    const binary = this.binaryPath()
    const file = await stat(binary).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Bundled aria2c is missing: ${binary}`)
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
      await this.run(binary, [
        '--no-conf=true', '--enable-rpc=false',
        '--continue=true', '--auto-file-renaming=false', '--allow-overwrite=false',
        '--max-connection-per-server=4', '--split=4', '--min-split-size=16M',
        '--max-tries=5', '--retry-wait=5', '--connect-timeout=30', '--timeout=30',
        '--summary-interval=0', '--console-log-level=error',
        `--dir=${directory}`, '--input-file=-',
      ], signal, `${input.url}\n  out=${stage}\n`)
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
