import { workdirIdOf } from './workdir-contracts.ts'
import { isAbsolute } from 'node:path'
import { GitReadError, localGitDiff, localGitStatus } from './git/local-git.ts'
import { isGitFilePath, type GitReadResponse } from './git/contracts.ts'
import { resolveExistingTarget, type WorkdirBinding } from './capability-filesystem.ts'
import type { ExecutionRequestV2 } from './contracts.ts'
import type { LocalJobOperationHandler } from './local-executor.ts'

export const GIT_STATUS_OPERATION = 'workdir.git.status'
export const GIT_DIFF_OPERATION = 'workdir.git.diff'
export const MAX_GIT_RESULT_BYTES = 4 * 1024 * 1024

export class CapabilityGit implements LocalJobOperationHandler {
  readonly #roots = new Map<string, string>()
  constructor(bindings: readonly WorkdirBinding[]) {
    for (const binding of bindings) {
      if (!binding.workdirId || this.#roots.has(binding.workdirId) || !isAbsolute(binding.rootPath)) {
        throw new TypeError('Git workdir bindings require unique IDs and absolute roots')
      }
      this.#roots.set(binding.workdirId, binding.rootPath)
    }
  }
  handles(operation: string): boolean {
    return operation === GIT_STATUS_OPERATION || operation === GIT_DIFF_OPERATION
  }
  async execute(request: ExecutionRequestV2, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted()
    const root = this.#roots.get(workdirIdOf(request))
    if (!root) throw new GitReadError('capability-denied', 'Git workdir is not registered on this device.', 400)
    let response: GitReadResponse
    try {
      const args = request.args
      if (!args || typeof args !== 'object' || Array.isArray(args) || !this.handles(request.operation)) {
        throw new GitReadError('invalid_git_args', 'Invalid Git inspection request.', 400)
      }
      const diff = request.operation === GIT_DIFF_OPERATION
      if (Object.keys(args).some(key => !diff || key !== 'path')
        || (diff && (!('path' in args) || !isGitFilePath(args.path) || args.path.length > 4096))) {
        throw new GitReadError('invalid_path', 'Choose a relative file path inside the remote workdir.', 400)
      }
      const base = await resolveExistingTarget(root, '.')
      const body = diff && 'path' in args && typeof args.path === 'string'
        ? await localGitDiff(base, args.path, signal)
        : await localGitStatus(base, signal)
      response = { status: 200, body }
    } catch (error) {
      if (!(error instanceof GitReadError)) throw error
      response = { status: error.status, body: { error: error.code, message: error.message } }
    }
    const output = JSON.stringify(response)
    if (Buffer.byteLength(output, 'utf8') > MAX_GIT_RESULT_BYTES) {
      return JSON.stringify({ status: 413, body: { error: 'git_output_limit', message: 'Remote Git result exceeds 4 MiB. Choose a smaller workdir or file.' } })
    }
    return output
  }
}
