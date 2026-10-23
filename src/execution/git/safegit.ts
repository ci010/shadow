import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const SAFEGIT_VERSION = '0.33.0-windows.1'
export const SAFEGIT_REPOSITORY = 'ci010/safegit'
export const SAFEGIT_ARCHIVES: Record<string, string> = {
  windows_amd64: '3f2928d2c8ce84c27e8c3415cb40c4a0c8d88ed4d7250a921f833b22d95c1488',
  darwin_amd64: '41d996b6659bd62a245819afbc81ec8f54ec76d976076379932890c8983dec7a',
  darwin_arm64: 'ae13cff2206b9e5a6621425b63df9543ae5637171b5abf992acbbaaf5085c787',
  linux_amd64: 'c10ca2af564c3f73a3e02a7ec5156e934f829ff41740d99375a9e3b5d243fe5d',
  linux_arm64: '2ed6dd6bda4d299dfb5bc57ae906eae46916450ae1a823a6cefef918468dd370',
}
export function safegitTarget(platform: string = process.platform, arch: string = process.arch): string | undefined {
  const key = `${platform === 'win32' ? 'windows' : platform}_${arch === 'x64' ? 'amd64' : arch}`
  return Object.hasOwn(SAFEGIT_ARCHIVES, key) ? key : undefined
}

export function requestedSafegitBinary(moduleUrl = import.meta.url, override = process.env.SHADOW_SAFEGIT_PATH): string {
  if (override) {
    if (!isAbsolute(override)) throw new TypeError('SHADOW_SAFEGIT_PATH must be absolute')
    return override
  }
  const modulePath = fileURLToPath(moduleUrl)
  const root = resolve(dirname(modulePath), '..', '..', '..', extname(modulePath) === '.ts' ? '.' : '..')
  if (existsSync(join(root, 'pnpm-workspace.yaml')) && existsSync(join(root, 'scripts', 'desktop.ts'))) {
    return join(root, 'desktop', 'safegit', process.platform === 'win32' ? 'safegit.exe' : 'safegit')
  }
  return resolve(dirname(modulePath), '..', '..', '..', '..', '..', 'safegit', process.platform === 'win32' ? 'safegit.exe' : 'safegit')
}

/** Local exec defaults only: no subprocess/version probe and no global env mutation.
 * Explicit host configuration wins for this resolver override; other dotenv keys
 * retain exec's normal precedence. Explicit values (including empty) are passed
 * through, not certified as available binaries.
 */
export async function localExecSafegitEnv(
  dotEnv: Record<string, string>,
  hostEnv: NodeJS.ProcessEnv = process.env,
  binaryPath: () => string = () => requestedSafegitBinary(import.meta.url, ''),
  target: () => string | undefined = safegitTarget,
): Promise<Record<string, string>> {
  const env = { ...dotEnv }
  if (hostEnv.SHADOW_SAFEGIT_PATH !== undefined) {
    env.SHADOW_SAFEGIT_PATH = hostEnv.SHADOW_SAFEGIT_PATH
    return env
  }
  if (env.SHADOW_SAFEGIT_PATH !== undefined) return env
  // Missing, unsupported or inaccessible bundles must not break ordinary exec.
  try {
    if (target()) {
      const binary = binaryPath()
      if ((await stat(binary)).isFile()) env.SHADOW_SAFEGIT_PATH = binary
    }
  } catch { /* Leave the default unset; the structured tool reports diagnostics. */ }
  return env
}

const exec = promisify(execFile)
export class SafegitRunner {
  constructor(
    private readonly binaryPath: () => string = requestedSafegitBinary,
    private readonly target: () => string | undefined = safegitTarget,
    private readonly execute: typeof exec = exec,
  ) {}

  async status(): Promise<{ supported: boolean; version: string; binary?: string; reason?: string }> {
    if (!this.target()) return { supported: false, version: SAFEGIT_VERSION,
      reason: 'Pinned safegit fork supports macOS/Linux x64/arm64 and Windows x64 only. No git or WSL fallback.' }
    const binary = this.binaryPath()
    const file = await stat(binary).catch(error => {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        throw new Error(`Pinned safegit ${SAFEGIT_VERSION} is missing: ${binary}. In source/dev run pnpm exec node --import tsx scripts/safegit-package.ts on a supported platform, or set an absolute SHADOW_SAFEGIT_PATH. Repair an incomplete installed app; no automatic fallback.`)
      }
      throw error
    })
    if (!file.isFile()) throw new Error(`Invalid safegit binary: ${binary}`)
    const { stdout } = await this.execute(binary, ['--version'], { timeout: 10_000, maxBuffer: 4096, windowsHide: true })
    if (!new RegExp(`(?:^|\\s)${SAFEGIT_VERSION.replaceAll('.', '\\.')}($|\\s)`).test(String(stdout))) {
      throw new Error(`Expected safegit ${SAFEGIT_VERSION}`)
    }
    return { supported: true, version: SAFEGIT_VERSION, binary }
  }

  async run(args: string[], cwd: string, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!isAbsolute(cwd)) throw new Error('safegit requires an absolute local workdir')
    if (!args.length || args.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid safegit arguments')
    const status = await this.status()
    if (!status.supported || !status.binary) throw new Error(status.reason ?? 'safegit is unsupported')
    try {
      const execution = this.execute(status.binary, args, {
        cwd, signal, shell: false, windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
      })
      // No interactive prompt input or implicit confirmation. EOF lets the CLI
      // refuse immediately rather than waiting for an unattended prompt.
      execution.child?.stdin?.end()
      const { stdout, stderr } = await execution
      return { exitCode: 0, stdout: String(stdout), stderr: String(stderr) }
    } catch (error) {
      // Preserve safegit's refusal/confirmation diagnostics. Spawn, abort, timeout
      // and output-limit failures remain errors, never success-shaped results.
      if (error instanceof Error && 'code' in error && typeof error.code === 'number'
        && !('killed' in error && error.killed) && 'stdout' in error && 'stderr' in error) {
        return { exitCode: error.code, stdout: String(error.stdout), stderr: String(error.stderr) }
      }
      throw error
    }
  }
}
