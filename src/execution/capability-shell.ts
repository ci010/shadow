import { stat } from 'node:fs/promises'
import { isAbsolute, win32, posix } from 'node:path'
import type { JobRequestV1 } from './contracts.ts'
import type { ProcessExecuteArgsV1 } from './executor.ts'
import type { LocalProcessOperationHandler } from './local-executor.ts'
import {
  resolveExistingTarget,
  type WorkdirCapabilityBinding,
} from './capability-filesystem.ts'
import type { ManagedShell } from './processes/shells.ts'

export const WORKDIR_PROCESS_EXECUTE_OPERATION = 'workdir.process.execute'
export const MAX_REMOTE_SHELL_TIMEOUT_MS = 120_000
export const MAX_REMOTE_SHELL_INPUT_BYTES = 32 * 1024

export interface WorkdirProcessArgs {
  script: string
  cwd?: string
  shell?: ManagedShell
  args?: string[]
}

export function parseWorkdirProcessArgs(value: unknown): WorkdirProcessArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalidArgs()
  const args = value as Record<string, unknown>
  if (
    Object.keys(args).some(key => !['script', 'cwd', 'shell', 'args'].includes(key)) ||
    typeof args.script !== 'string' || !args.script.trim() || args.script.includes('\0') ||
    (args.shell !== undefined && !['cmd', 'sh', 'bash', 'git-bash', 'powershell', 'pwsh'].includes(String(args.shell))) ||
    (args.args !== undefined && (!Array.isArray(args.args) ||
      args.args.some(arg => typeof arg !== 'string' || arg.includes('\0')))) ||
    (args.cwd !== undefined && (typeof args.cwd !== 'string' || !args.cwd ||
      args.cwd.includes('\0') || posix.isAbsolute(args.cwd) || win32.isAbsolute(args.cwd) ||
      /^[a-z]:/i.test(args.cwd) || args.cwd.split(/[\\/]/).includes('..')))
  ) throw invalidArgs()
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_REMOTE_SHELL_INPUT_BYTES) {
    throw invalidArgs()
  }
  return args as unknown as WorkdirProcessArgs
}

function invalidArgs(): Error & { code: string } {
  return Object.assign(new Error(
    'Remote shell requires a nonempty script, an OS shell, string args, and a capability-relative cwd (no absolute paths or parent traversal); input limit is 32 KiB.',
  ), { code: 'invalid-workdir-process-args' })
}

/** Binds the initial cwd only; the approved shell runs with the Child user's authority. */
export class CapabilityShell implements LocalProcessOperationHandler {
  readonly #roots = new Map<string, string>()

  constructor(bindings: readonly WorkdirCapabilityBinding[]) {
    for (const binding of bindings) {
      if (!binding.capabilityId || this.#roots.has(binding.capabilityId) ||
        !isAbsolute(binding.rootPath)) {
        throw new TypeError('Workdir shell bindings require unique IDs and absolute roots')
      }
      this.#roots.set(binding.capabilityId, binding.rootPath)
    }
  }

  handles(operation: string): boolean {
    return operation === WORKDIR_PROCESS_EXECUTE_OPERATION || operation === 'workdir.process.execute-once'
  }

  async prepareProcess(request: JobRequestV1, signal: AbortSignal): Promise<ProcessExecuteArgsV1> {
    signal.throwIfAborted()
    const root = this.#roots.get(request.capabilityId)
    if (!root) {
      throw Object.assign(new Error('Workdir shell capability is not granted'), { code: 'capability-denied' })
    }
    const args = parseWorkdirProcessArgs(request.args)
    const cwd = await resolveExistingTarget(root, args.cwd ?? '.')
    if (!(await stat(cwd)).isDirectory()) throw invalidArgs()
    signal.throwIfAborted()
    return { ...args, cwd }
  }
}
