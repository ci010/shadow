import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { copyUserProfile, type ProfileSource } from './profile-copy.ts'
import { attachmentTarget } from './session-browsers.ts'

export interface ManagedChromeChoice extends ProfileSource { executablePath: string }
export interface ManagedChromeProcess {
  readonly exited: boolean
  stop(): Promise<void>
}
export interface SharedChromeRuntime {
  validateExecutable(path: string): Promise<void>
  launch(executable: string, args: string[]): ManagedChromeProcess
  endpoint(directory: string, process: ManagedChromeProcess, signal: AbortSignal): Promise<string>
}

export function browserProcessArguments(directory: string, profile: string): string[] {
  return ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-data-dir=${directory}`, `--profile-directory=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-sync', '--disable-extensions', 'about:blank']
}

/** No custom program execution through browser-only permissions. Resolve only known
 * Chrome installation locations; metadata lookup happens after explicit setup.
 */
export async function validateChromeExecutable(executable: string): Promise<void> {
  const candidates = process.platform === 'win32'
    ? [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter((root): root is string => !!root)
      .flatMap(root => ['Chrome', 'Chrome Beta', 'Chrome Dev', 'Chrome SxS'].map(channel => join(root, 'Google', channel, 'Application', 'chrome.exe')))
    : process.platform === 'darwin'
      ? ['/Applications', join(homedir(), 'Applications')].flatMap(root => ['Google Chrome', 'Google Chrome Beta', 'Google Chrome Dev', 'Google Chrome Canary']
        .map(name => join(root, `${name}.app`, 'Contents', 'MacOS', name)))
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome-beta', '/usr/bin/google-chrome-unstable', '/opt/google/chrome/chrome']
  let selected: string
  try { selected = await realpath(executable) } catch { throw new Error('Chosen Chrome installation is unavailable.') }
  for (const candidate of candidates) {
    try { if (await realpath(candidate) === selected) return } catch { /* absent installation */ }
  }
  throw new Error('Managed launch supports only recognized Chrome installation paths. Custom executables are not allowed; use explicitly approved attach for other browsers.')
}

/** An error after spawn (notably kill failure) is NOT proof of process exit. */
export function superviseChromeChild(child: ChildProcess): ManagedChromeProcess {
  let exited = false
  const failure = Promise.withResolvers<void>()
  void failure.promise.catch(() => {})
  const done = new Promise<void>(resolve => {
    child.on('error', () => {
      if (child.pid === undefined) { exited = true; resolve() } // failed spawn, no process
      else failure.reject(new Error('Managed Chrome process operation failed; exit is unconfirmed.'))
    })
    child.once('exit', () => { exited = true; resolve() })
  })
  return {
    get exited() { return exited },
    async stop() {
      if (exited) return
      if (!child.kill()) throw new Error('Managed Chrome termination failed; exit is unconfirmed.')
      const timeout = new AbortController()
      try {
        await Promise.race([done, failure.promise, delay(5000, undefined, { signal: timeout.signal }).then(() => {
          if (!exited) throw new Error('Managed Chrome did not exit; refusing another launch.')
        })])
      } finally { timeout.abort() }
    },
  }
}

export const nativeChromeRuntime: SharedChromeRuntime = {
  validateExecutable: validateChromeExecutable,
  launch(executable, args) {
    return superviseChromeChild(spawn(executable, args, { stdio: 'ignore', windowsHide: false, shell: false }))
  },  async endpoint(directory, process, signal) {
    const deadline = Date.now() + 15000
    while (Date.now() < deadline) {
      signal.throwIfAborted()
      if (process.exited) throw new Error('Managed Chrome exited before CDP was ready.')
      try {
        const [port, path] = (await readFile(join(directory, 'DevToolsActivePort'), 'utf8')).trim().split(/\r?\n/)
        if (/^[0-9]+$/.test(port) && Number(port) > 0 && Number(port) <= 65535 && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(path)) {
          return `ws://127.0.0.1:${port}${path}`
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Cannot read managed CDP endpoint.') }
      await delay(100, undefined, { signal })
    }
    throw new Error('Managed Chrome CDP startup timed out.')
  },
}

/** One manager per Project runtime, NOT per session and never global across Projects.
 * Sessions own adapters only. A stopped child can restart against its existing copy;
 * each new runtime gets a fresh unique directory and never overwrites old copies.
 */
export class SharedChrome {
  private choice?: ManagedChromeChoice
  private directory?: string
  private process?: ManagedChromeProcess
  private endpoint?: string
  private pending?: Promise<string>
  private readonly lifetime = new AbortController()

  constructor(private readonly storage: string, private readonly runtime: SharedChromeRuntime = nativeChromeRuntime) {}

  ensure(choice: ManagedChromeChoice): Promise<string> {
    if (this.lifetime.signal.aborted) return Promise.reject(new Error('Project browser manager is closed.'))
    if (!isAbsolute(choice.executablePath) || !isAbsolute(choice.userDataDir) || !/^(Default|Profile [0-9]+)$/.test(choice.profileDirectory)) {
      return Promise.reject(new Error('Managed Chrome requires explicit absolute executable/root paths and Default or Profile N.'))
    }
    if (this.choice && (this.choice.executablePath !== choice.executablePath || this.choice.userDataDir !== choice.userDataDir || this.choice.profileDirectory !== choice.profileDirectory)) {
      return Promise.reject(new Error('This Project already selected another shared profile/browser. Do not replace it while sessions may be using it; use the existing choice or a separate Project.'))
    }
    this.choice ??= { ...choice }
    if (this.pending) return this.pending
    this.pending = this.start(this.choice).catch(error => {
      if (!this.directory && !this.process) this.choice = undefined
      throw error
    }).finally(() => { this.pending = undefined })
    return this.pending
  }

  private async start(choice: ManagedChromeChoice): Promise<string> {
    const signal = this.lifetime.signal
    if (this.process && !this.process.exited) {
      if (this.endpoint) return this.endpoint
      throw new Error('Managed Chrome is still running without a usable endpoint; no replacement was launched.')
    }
    this.endpoint = undefined
    if (!this.directory) {
      // Validate the executable before copying; never inspect a default/personal profile.
      await this.runtime.validateExecutable(choice.executablePath)
      if (!(await stat(choice.executablePath)).isFile()) throw new Error('Chosen browser executable is not a file.')
      await mkdir(this.storage, { recursive: true, mode: 0o700 })
      const container = await mkdtemp(join(await realpath(this.storage), 'chrome-'))
      const directory = join(container, 'User Data')
      await copyUserProfile(choice, directory, signal)
      this.directory = directory
    }
    signal.throwIfAborted()
    // Only our copy, and only after our previous child is confirmed exited.
    await rm(join(this.directory, 'DevToolsActivePort'), { force: true })
    this.process = this.runtime.launch(choice.executablePath, browserProcessArguments(this.directory, choice.profileDirectory))
    try {
      const endpoint = await this.runtime.endpoint(this.directory, this.process, signal)
      signal.throwIfAborted()
      attachmentTarget(endpoint) // enforce loopback even at the injectable process boundary
      this.endpoint = endpoint
      return endpoint
    } catch (error) {
      await this.process.stop()
      throw error
    }
  }

  /** Called only by Project lifecycle, not by session close/sleep/reset. Copies remain. */
  async shutdown(): Promise<void> {
    this.lifetime.abort(new Error('Project browser manager closed.'))
    await this.pending?.catch(() => {})
    await this.process?.stop()
  }
}
