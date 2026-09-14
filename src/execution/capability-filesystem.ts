import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { lstat, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { isNotFoundError } from '../utils/runtime.ts'
import type { JobRequestV1 } from './contracts.ts'
import type { LocalJobOperationHandler } from './local-executor.ts'

export const FILESYSTEM_READ_OPERATION = 'filesystem.read'
export const FILESYSTEM_WRITE_OPERATION = 'filesystem.write'

export interface WorkdirCapabilityBinding {
  readonly capabilityId: string
  readonly rootPath: string
}

export interface CapabilityFilesystemOptions {
  readonly maxReadBytes?: number
  readonly maxWriteBytes?: number
}

export type CapabilityFilesystemErrorCode =
  | 'capability-denied'
  | 'invalid-filesystem-args'
  | 'path-denied'
  | 'file-not-found'
  | 'file-type-denied'
  | 'filesystem-result-too-large'
  | 'filesystem-io-failed'

export class CapabilityFilesystemError extends Error {
  constructor(
    readonly code: CapabilityFilesystemErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'CapabilityFilesystemError'
  }
}

const DEFAULT_MAX_READ_BYTES = 256 * 1024
const DEFAULT_MAX_WRITE_BYTES = 1024 * 1024

export class CapabilityFilesystem implements LocalJobOperationHandler {
  readonly #roots = new Map<string, string>()
  readonly #maxReadBytes: number
  readonly #maxWriteBytes: number

  constructor(
    bindings: readonly WorkdirCapabilityBinding[],
    options: CapabilityFilesystemOptions = {},
  ) {
    this.#maxReadBytes = positiveInteger(
      options.maxReadBytes ?? DEFAULT_MAX_READ_BYTES,
      'maxReadBytes',
    )
    this.#maxWriteBytes = positiveInteger(
      options.maxWriteBytes ?? DEFAULT_MAX_WRITE_BYTES,
      'maxWriteBytes',
    )
    for (const binding of bindings) {
      if (!binding.capabilityId || this.#roots.has(binding.capabilityId)) {
        throw new TypeError(
          'Workdir capability IDs must be unique and non-empty',
        )
      }
      if (!isAbsolute(binding.rootPath)) {
        throw new TypeError('Workdir capability roots must be absolute paths')
      }
      this.#roots.set(binding.capabilityId, resolve(binding.rootPath))
    }
  }

  handles(operation: string): boolean {
    return operation === FILESYSTEM_READ_OPERATION ||
      operation === FILESYSTEM_WRITE_OPERATION
  }

  async execute(request: JobRequestV1, signal: AbortSignal): Promise<string> {
    const root = this.#roots.get(request.capabilityId)
    if (!root) {
      throw new CapabilityFilesystemError(
        'capability-denied',
        'Filesystem capability is not granted',
      )
    }
    signal.throwIfAborted()
    if (request.operation === FILESYSTEM_READ_OPERATION) {
      return await this.#read(root, request.args, signal)
    }
    if (request.operation === FILESYSTEM_WRITE_OPERATION) {
      return await this.#write(root, request.args, signal)
    }
    throw new CapabilityFilesystemError(
      'invalid-filesystem-args',
      'Filesystem operation is unsupported',
    )
  }

  async #read(
    root: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    const args = parseReadArgs(value)
    const target = await resolveExistingTarget(root, args.path)
    try {
      signal.throwIfAborted()
      const info = await stat(target)
      if (info.isDirectory()) {
        const entries: string[] = []
        for (const entry of await readdir(target, { withFileTypes: true })) {
          signal.throwIfAborted()
          entries.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
        }
        const output = entries.sort((left, right) => left.localeCompare(right))
          .join('\n')
        if (new TextEncoder().encode(output).length > this.#maxReadBytes) {
          throw resultTooLarge('read')
        }
        return output
      }
      if (!info.isFile()) {
        throw new CapabilityFilesystemError(
          'file-type-denied',
          'Filesystem target must be a regular file or directory',
        )
      }
      if (info.size > this.#maxReadBytes) throw resultTooLarge('read')
      const bytes = await readFile(target)
      signal.throwIfAborted()
      if (bytes.length > this.#maxReadBytes) throw resultTooLarge('read')
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch (error) {
      if (error instanceof CapabilityFilesystemError) throw error
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      if (error instanceof TypeError) {
        throw new CapabilityFilesystemError(
          'file-type-denied',
          'Filesystem read requires UTF-8 text',
        )
      }
      throw new CapabilityFilesystemError(
        'filesystem-io-failed',
        'Filesystem read failed',
      )
    }
  }

  async #write(
    root: string,
    value: unknown,
    signal: AbortSignal,
  ): Promise<string> {
    const args = parseWriteArgs(value)
    const bytes = new TextEncoder().encode(args.content)
    if (bytes.length > this.#maxWriteBytes) {
      throw resultTooLarge('write')
    }
    const target = await resolveWritableFile(root, args.path)
    try {
      signal.throwIfAborted()
      await writeFile(target, args.content, {
        flag: args.mode === 'append' ? 'a' : 'w',
      })
      signal.throwIfAborted()
      return `${bytes.length} bytes written`
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        throw error
      }
      throw new CapabilityFilesystemError(
        'filesystem-io-failed',
        'Filesystem write failed',
      )
    }
  }
}

export async function resolveExistingTarget(
  root: string,
  input: string,
): Promise<string> {
  const target = lexicalTarget(root, input, true)
  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(root),
      realpath(target),
    ])
    if (escapesRoot(realRoot, realTarget)) {
      throw pathDenied()
    }
    return realTarget
  } catch (error) {
    if (error instanceof CapabilityFilesystemError) throw error
    if (isNotFoundError(error)) {
      throw new CapabilityFilesystemError(
        'file-not-found',
        'Filesystem target was not found',
      )
    }
    throw pathDenied()
  }
}

async function resolveWritableFile(
  root: string,
  input: string,
): Promise<string> {
  const target = lexicalTarget(root, input)
  try {
    const [realRoot, realParent] = await Promise.all([
      realpath(root),
      realpath(dirname(target)),
    ])
    if (escapesRoot(realRoot, realParent)) throw pathDenied()
    try {
      const [targetInfo, realTarget] = await Promise.all([
        lstat(target),
        realpath(target),
      ])
      if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) throw pathDenied()
      if (escapesRoot(realRoot, realTarget)) throw pathDenied()
      return realTarget
    } catch (error) {
      if (error instanceof CapabilityFilesystemError) throw error
      if (!isNotFoundError(error)) throw pathDenied()
    }
    return target
  } catch (error) {
    if (error instanceof CapabilityFilesystemError) throw error
    throw pathDenied()
  }
}

function lexicalTarget(
  root: string,
  input: string,
  allowRoot = false,
): string {
  if (!input || isAbsolute(input) || input.includes('\0')) throw pathDenied()
  const target = resolve(root, input)
  if ((!allowRoot && target === root) || escapesRoot(root, target)) {
    throw pathDenied()
  }
  return target
}

function escapesRoot(root: string, target: string): boolean {
  const value = relative(root, target)
  return value === '..' || value.startsWith('../') ||
    value.startsWith('..\\') || isAbsolute(value)
}

function pathDenied(): CapabilityFilesystemError {
  return new CapabilityFilesystemError(
    'path-denied',
    'Filesystem path is outside the granted capability',
  )
}

function parseReadArgs(value: unknown): { path: string } {
  const candidate = recordWithKeys(value, ['path'])
  if (typeof candidate.path !== 'string' || candidate.path.length === 0) {
    throw invalidArgs()
  }
  return { path: candidate.path }
}

function parseWriteArgs(value: unknown): {
  path: string
  content: string
  mode: 'replace' | 'append'
} {
  const candidate = recordWithKeys(value, ['path', 'content', 'mode'])
  if (
    typeof candidate.path !== 'string' || candidate.path.length === 0 ||
    typeof candidate.content !== 'string' ||
    (
      candidate.mode !== undefined && candidate.mode !== 'replace' &&
      candidate.mode !== 'append'
    )
  ) throw invalidArgs()
  return {
    path: candidate.path,
    content: candidate.content,
    mode: candidate.mode === 'append' ? 'append' : 'replace',
  }
}

function recordWithKeys(
  value: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidArgs()
  }
  const candidate = value as Record<string, unknown>
  if (Object.keys(candidate).some((key) => !allowed.includes(key))) {
    throw invalidArgs()
  }
  return candidate
}

function invalidArgs(): CapabilityFilesystemError {
  return new CapabilityFilesystemError(
    'invalid-filesystem-args',
    'Filesystem operation arguments are invalid',
  )
}

function resultTooLarge(
  operation: 'read' | 'write',
): CapabilityFilesystemError {
  return new CapabilityFilesystemError(
    'filesystem-result-too-large',
    `Filesystem ${operation} exceeds the configured size limit`,
  )
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`)
  }
  return value
}
