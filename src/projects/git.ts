import { spawn } from 'node:child_process'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { absoluteDirectoryPath, ProjectError } from './registry.ts'

export interface GitCloneRequest {
  url: string
  destination: string
  signal: AbortSignal
}

export type GitCloneRunner = (request: GitCloneRequest) => Promise<void>

function validSshHost(host: string): boolean {
  if (host.startsWith('[') && host.endsWith(']')) {
    return isIP(host.slice(1, -1)) === 6
  }
  if (isIP(host)) return true
  if (/^[\d.]+$/.test(host)) return false
  const dnsName = host.endsWith('.') ? host.slice(0, -1) : host
  return dnsName.length <= 253 && dnsName.split('.').every((label) =>
    /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label)
  )
}

export function validateCloneUrl(value: unknown): string {
  const invalid = () => new ProjectError(
    'invalid_clone_url',
    'Use an HTTPS or SSH Git URL without a password, query, or fragment.',
  )
  if (
    typeof value !== 'string' || value.length > 4096 ||
    /[\s\x00-\x20"'`$;&|<>\\?#]/.test(value)
  ) throw invalid()
  const scp = /^git@(\[[^\]]+\]|[^:]+):[a-z0-9_~][a-z0-9_./~+-]*$/i.exec(value)
  if (scp) {
    if (!validSshHost(scp[1])) throw invalid()
    return value
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw invalid()
  }
  if (url.password || url.search || url.hash) throw invalid()
  if (url.protocol === 'https:' && url.hostname && !url.username && url.pathname !== '/') {
    return url.href
  }
  if (
    url.protocol === 'ssh:' && validSshHost(url.hostname) && (!url.username || url.username === 'git') &&
    /^\/[a-z0-9_~][a-z0-9_./~+-]*$/i.test(url.pathname)
  ) return url.href
  if (url.protocol === 'file:' && !url.hostname && !url.username) {
    try {
      return pathToFileURL(absoluteDirectoryPath(fileURLToPath(url))).href
    } catch {
      throw invalid()
    }
  }
  throw invalid()
}

export function validateDirectoryName(value: unknown): string {
  if (
    typeof value !== 'string' || !value || value.length > 120 ||
    value === '.' || value === '..' ||
    /[\x00-\x1f\x7f<>:"/\\|?*]/.test(value) || /[. ]$/.test(value) ||
    /^[ .-]/.test(value) ||
    /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(value)
  ) {
    throw new ProjectError(
      'invalid_directory_name',
      'Choose a single folder name without path separators or reserved characters.',
    )
  }
  return value
}

export class CloneTerminationError extends Error {
  constructor() {
    super('Clone could not be stopped completely. Check for remaining Git processes in your system process manager before retrying. Any partial folder was kept.')
    this.name = 'CloneTerminationError'
  }
}

export function hasOwnedProcessExited(
  pid: number,
  probe: (pid: number, signal: 0) => unknown = process.kill,
): boolean {
  try {
    probe(pid, 0)
    return false
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
    throw error
  }
}

async function killTree(pid: number): Promise<void> {
  if (process.platform !== 'win32') {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    return
  }
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'),
      ['/PID', String(pid), '/T', '/F'],
      { shell: false, windowsHide: true, stdio: 'ignore' },
    )
    killer.once('error', reject)
    killer.once('close', (code) => {
      // A naturally exited process can disappear before taskkill reaches it.
      if (code === 0) return resolve()
      try {
        if (hasOwnedProcessExited(pid)) resolve()
        else reject(new CloneTerminationError())
      } catch (error) {
        reject(error)
      }
    })
  })
}

export async function runOwnedProcess(
  command: string,
  args: string[],
  options: { signal: AbortSignal; env?: NodeJS.ProcessEnv; cwd?: string },
): Promise<void> {
  options.signal.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: 'ignore',
    })
    let spawnError: Error | undefined
    let stopping: Promise<void> | undefined
    const abort = () => {
      if (child.pid !== undefined && !stopping) {
        stopping = killTree(child.pid)
        // A failed tree kill must surface even if the root cannot be stopped.
        // Killing only the root is best-effort cleanup, not successful cancellation.
        void stopping.catch(() => {
          try {
            child.kill('SIGKILL')
          } catch {
            // The caller receives a stop failure and can recover manually.
          }
          reject(new CloneTerminationError())
        })
      }
    }
    options.signal.addEventListener('abort', abort, { once: true })
    child.once('error', (error) => { spawnError = error })
    child.once('close', async (code) => {
      options.signal.removeEventListener('abort', abort)
      try {
        if (stopping) {
          try {
            await stopping
          } catch {
            throw new CloneTerminationError()
          }
        }
        options.signal.throwIfAborted()
        if (spawnError || code !== 0) throw new Error('Git clone did not complete')
        resolve()
      } catch (error) {
        reject(error)
      }
    })
    if (options.signal.aborted) abort()
  })
}

export const runGitClone: GitCloneRunner = async ({ url, destination, signal }) => {
  await runOwnedProcess('git', [
    '-c', 'protocol.allow=never',
    '-c', 'protocol.https.allow=always',
    '-c', 'protocol.ssh.allow=always',
    '-c', 'protocol.file.allow=always',
    'clone', '--', url, destination,
  ], {
    signal,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'Never',
      GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
    },
  })
}
