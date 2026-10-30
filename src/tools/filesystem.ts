import { executionTargetContext, executionTargetParameters } from './execution-target.ts'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import { isUtf8 } from 'node:buffer'
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import type { ExecutionContext } from './context.ts'
import { isNotFoundError, isWindows } from '../utils/runtime.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { ToolNoEffectError, type Tool, type ToolParameters } from './tool.ts'
import {
  FILESYSTEM_READ_OPERATION,
  FILESYSTEM_WRITE_OPERATION,
} from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText, RemoteFilesystemError } from '../execution/remote-filesystem-client.ts'
import { formatWriteResult, MAX_WRITE_REGIONS, type ReplacementResult } from './write-result.ts'
import { countLineChanges, MAX_LINE_DIFF_CHARS } from './line-changes.ts'
import { isVirtualPath, type VirtualFs } from '../vfs/virtual-fs.ts'
import { recordFileWrite } from './file-change.ts'

export { ReadTool } from './read.ts'

const PATH_SEPARATOR = isWindows ? '\\' : '/'

function normalizeForComparison(filePath: string): string {
  const normalized = resolve(filePath)
  return isWindows ? normalized.toLowerCase() : normalized
}

function isWithinPath(rootPath: string, targetPath: string): boolean {
  const root = normalizeForComparison(rootPath)
  const target = normalizeForComparison(targetPath)
  return target === root || target.startsWith(`${root}${PATH_SEPARATOR}`)
}

function displayPath(absPath: string, workspace: string): string {
  const rel = relative(workspace, absPath)
  return rel.startsWith('..') ? absPath : rel
}

/** Optional observation must not turn a write-only target into a failed overwrite. */
async function observeBeforeOverwrite(path: string, signal: AbortSignal): Promise<
  { content: string; unavailable?: never } | { content?: never; unavailable: string }
> {
  try {
    signal.throwIfAborted()
    const file = await open(path, 'r')
    try {
      const info = await file.stat()
      if (!info.isFile()) return { unavailable: 'Previous target is not a regular file.' }
      if (info.size > MAX_LINE_DIFF_CHARS) {
        return { unavailable: 'Previous file exceeds the pre-write observation size limit.' }
      }
      // Bound the read even if another writer grows the file after stat.
      const bytes = Buffer.alloc(MAX_LINE_DIFF_CHARS + 1)
      let length = 0
      while (length < bytes.length) {
        signal.throwIfAborted()
        const { bytesRead } = await file.read(bytes, length, bytes.length - length, null)
        if (!bytesRead) break
        length += bytesRead
      }
      signal.throwIfAborted()
      if (length > MAX_LINE_DIFF_CHARS) {
        return { unavailable: 'Previous file exceeds the pre-write observation size limit.' }
      }
      return { content: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, length)) }
    } finally {
      await file.close()
    }
  } catch (error) {
    signal.throwIfAborted()
    if (error instanceof Error && error.name === 'AbortError') throw error
    if (isNotFoundError(error)) return { content: '' }
    const code = (error as NodeJS.ErrnoException)?.code
    return { unavailable: code === 'EACCES' || code === 'EPERM' || code === 'ERR_ACCESS_DENIED'
      ? 'Reading the previous file was not permitted.'
      : 'Previous file could not be read as UTF-8 text.' }
  }
}

// ── Exact edits with original-text offsets ─────────────────────────────────────

export function applyReplacement(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): string | null {
  return applyReplacementDetailed(content, oldStr, newStr, replaceAll)?.content ?? null
}

export function applyReplacementDetailed(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll = false,
): ReplacementResult | null {
  if (!oldStr) return null
  // Compare logical newlines, but splice the original text so untouched bytes,
  // including mixed line endings and the BOM, remain unchanged.
  const offsets: number[] = []
  const characters: string[] = []
  for (let i = 0; i < content.length; i++) {
    offsets.push(i)
    if (content[i] === '\r' && content[i + 1] === '\n') {
      characters.push('\n')
      i++
    } else characters.push(content[i])
  }
  offsets.push(content.length)
  const normalized = characters.join('')
  const needle = oldStr.replace(/\r\n/g, '\n')
  const positions: number[] = []
  let cursor = 0
  while (cursor <= normalized.length - needle.length) {
    const index = normalized.indexOf(needle, cursor)
    if (index < 0) break
    positions.push(index)
    if (!replaceAll && positions.length > 1) return null
    cursor = index + (replaceAll ? needle.length : 1)
  }
  if (!positions.length || (!replaceAll && positions.length !== 1)) return null
  let updated = ''
  let previousEnd = 0
  const ranges: ReplacementResult['ranges'] = []
  for (const index of positions) {
    const start = offsets[index]
    const end = offsets[index + needle.length]
    // Prefer a line ending inside the target, then the surrounding line.
    let replacement = newStr
    if (newStr.includes('\n')) {
      const targetEol = content.slice(start, end).match(/\r\n|\n/)
      const followingEol = targetEol ? null : content.slice(start).match(/\r\n|\n/)
      const precedingEols = targetEol || followingEol ? null : content.slice(0, start).match(/\r\n|\n/g)
      const eol = targetEol?.[0] ?? followingEol?.[0] ?? precedingEols?.at(-1) ?? '\n'
      replacement = newStr.replace(/\r\n/g, '\n').replace(/\n/g, eol)
    }
    updated += content.slice(previousEnd, start)
    const rangeStart = updated.length
    updated += replacement
    if (ranges.length < MAX_WRITE_REGIONS) ranges.push({ start: rangeStart, end: updated.length })
    previousEnd = end
  }
  updated += content.slice(previousEnd)
  return { content: updated, strategy: 'exact', count: positions.length, ranges }
}

// ── Unified write tool ────────────────────────────────────────────────────────

export class WriteTool implements Tool {
  readonly name = 'write'
  readonly supportsRemoteWorkdir = true
  readonly description =
    'Write or edit a file. With `match`: find and replace. Creates directories as needed. Returns a short receipt; use view_edit with the returned edit ID for the recorded patch.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      ...executionTargetParameters,
      path: { type: 'string', description: 'File path' },
      content: {
        type: 'string',
        description: 'Full file content, or replacement text when match is set',
      },
      match: {
        type: 'string',
        description: 'Exact text to find (LF/CRLF equivalent). Must be nonempty and unique unless flag g is set. No fuzzy matching; edits preserve existing line endings and BOM.',
      },
      flag: {
        type: 'string',
        description: 'g = replace all occurrences, a = append to file',
      },
      encoding: {
        type: 'string', enum: ['utf8', 'utf8-bom'],
        description: 'Full overwrite only; default utf8. Use utf8-bom for non-ASCII .ps1 files executed by Windows PowerShell 5.1. Edits preserve an existing BOM.',
      },
    },
    required: ['path', 'content'],
  }

  constructor(
    private workspace: string,
    private restrictToWorkspace: boolean = false,
    private virtualFs?: VirtualFs,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    if (isVirtualPath(String(args.path))) return `📝 ${String(args.path)}`
    const filePath = this.resolve(String(args.path))
    const icon = args.match ? '✏️' : '📝'
    return `${icon} ${displayPath(filePath, this.workspace)}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    context = executionTargetContext(args, context)
    context.signal.throwIfAborted()
    const rawPath = String(args.path)
    const virtualPath = isAbsolute(rawPath) ? relative(this.workspace, rawPath) : rawPath
    if (args.encoding !== undefined) {
      if (typeof args.encoding !== 'string' || !['utf8', 'utf8-bom'].includes(args.encoding)
        || args.match != null || String(args.flag ?? '').includes('a') || isVirtualPath(virtualPath)) {
        throw new ToolNoEffectError('Invalid encoding: use utf8 or utf8-bom only for a full filesystem overwrite, not append, edit or virtual writes.')
      }
      if (args.encoding === 'utf8-bom') {
        const content = String(args.content)
        args = { ...args, content: content.startsWith('\uFEFF') ? content : '\uFEFF' + content }
      }
    }
    if (isVirtualPath(virtualPath)) {
      if (!this.virtualFs) return 'Error: unknown virtual filesystem path.'
      const flags = typeof args.flag === 'string' ? args.flag : ''
      if (/[^g]/.test(flags)) return 'Error: virtual writes support overwrite or exact edit only; append is unsupported.'
      if (args.mode !== undefined || args.old_str !== undefined || args.new_str !== undefined || args.replace_all !== undefined) {
        return 'Error: use content for overwrite, or match/content and optional flag "g" for exact virtual edits.'
      }
      return await this.virtualFs.write(virtualPath, {
        content: String(args.content),
        match: args.match != null ? String(args.match) : undefined,
        replaceAll: flags.includes('g'),
      }, context) ?? 'Error: unknown virtual filesystem path.'
    }
    if (context.remoteWorkdir) {
      return await this.writeRemote(args, context)
    }
    const filePath = this.resolve(String(args.path), context)
    const restriction = this.checkWriteAllowed(filePath)
    if (restriction) return restriction

    const content = String(args.content)
    const flags = typeof args.flag === 'string' ? args.flag : ''
    const match = args.match != null ? String(args.match) : undefined

    if (match !== undefined) {
      // ── Edit mode: find and replace ──
      let existing: string
      let observedBefore: string | undefined
      try {
        const bytes = await readFile(filePath, { signal: context.signal })
        if (!isUtf8(bytes) || bytes.includes(0)) throw new ToolNoEffectError('Edit/append requires UTF-8 text; original file unchanged. Convert non-UTF-8 files explicitly before modifying.')
        existing = bytes.toString('utf8')
        if (isUtf8(bytes)) observedBefore = existing
      } catch (error) {
        if (!isNotFoundError(error)) throw error
        return `Error: file not found: ${filePath}`
      }
      context.signal.throwIfAborted()
      const replaceAll = flags.includes('g')
      const updated = applyReplacementDetailed(existing, match, content, replaceAll)
      if (updated === null) {
        return 'Error: match must be nonempty and occur exactly once (or use flag g for all occurrences); original file unchanged.'
      }
      context.signal.throwIfAborted()
      await writeFile(filePath, updated.content)
      const change = await recordFileWrite(context, { path: filePath, mode: 'edit', before: observedBefore, after: updated.content,
        unavailable: 'Previous file could not be represented as UTF-8 text.' })
      context.signal.throwIfAborted()
      return formatWriteResult({
        mode: 'edit', change,
        edit: updated, unchanged: existing === updated.content, global: replaceAll,
        lineChanges: countLineChanges(existing, updated.content),
      })
    }

    if (flags.includes('a')) {
      // ── Append mode ──
      let existing = ''
      let observedBefore: string | undefined = ''
      try {
        const bytes = await readFile(filePath, { signal: context.signal })
        if (!isUtf8(bytes) || bytes.includes(0)) throw new ToolNoEffectError('Edit/append requires UTF-8 text; original file unchanged. Convert non-UTF-8 files explicitly before modifying.')
        existing = bytes.toString('utf8')
        observedBefore = isUtf8(bytes) ? existing : undefined
      } catch (error) {
        if (!isNotFoundError(error)) throw error
      }
      context.signal.throwIfAborted()
      await mkdir(dirname(filePath), { recursive: true })
      context.signal.throwIfAborted()
      await appendFile(filePath, content)
      const change = await recordFileWrite(context, { path: filePath, mode: 'append', before: observedBefore,
        after: observedBefore === undefined ? content : existing + content, unavailable: 'Previous file could not be represented as UTF-8 text.' })
      context.signal.throwIfAborted()
      return formatWriteResult({
        mode: 'append', change, unchanged: content === '',
        lineChanges: countLineChanges(existing, existing + content),
      })
    }

    // ── Full write mode ──
    const before = await observeBeforeOverwrite(filePath, context.signal)
    context.signal.throwIfAborted()
    await mkdir(dirname(filePath), { recursive: true })
    context.signal.throwIfAborted()
    await writeFile(filePath, content)
    const change = await recordFileWrite(context, { path: filePath, mode: 'write', before: before.content, after: content, unavailable: before.unavailable })
    context.signal.throwIfAborted()
    return formatWriteResult({
      mode: 'write', change, unchanged: before.content === content,
      lineChanges: before.content !== undefined
        ? countLineChanges(before.content, content)
        : { unavailable: before.unavailable },
    })
  }

  private async writeRemote(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const path = String(args.path)
    const content = String(args.content)
    const flags = typeof args.flag === 'string' ? args.flag : ''
    const match = args.match != null ? String(args.match) : undefined
    let nextContent = content
    let mode: 'replace' | 'append' = flags.includes('a') ? 'append' : 'replace'
    let edit: ReplacementResult | undefined
    let existing: string | undefined
    let boundaryUnavailable: string | undefined
    let observationUnavailable: string | undefined

    if (match !== undefined) {
      existing = await executeRemoteFilesystemText(
        remoteFilesystemTarget(context),
        FILESYSTEM_READ_OPERATION,
        { path },
      )
      context.signal.throwIfAborted()
      const updated = applyReplacementDetailed(
        existing,
        match,
        content,
        flags.includes('g'),
      )
      if (updated === null) return 'Error: match must be nonempty and occur exactly once (or use flag g for all occurrences); original file unchanged.'
      edit = updated
      nextContent = updated.content
      mode = 'replace'
    } else {
      try {
        existing = await executeRemoteFilesystemText(
          remoteFilesystemTarget(context), FILESYSTEM_READ_OPERATION, { path },
        )
      } catch (error) {
        context.signal.throwIfAborted()
        if (!(error instanceof RemoteFilesystemError)) throw error
        if (error.code === 'cancelled' || error.code === 'aborted') throw error
        if (error.code === 'file-not-found') existing = ''
        else if (mode === 'replace') {
          observationUnavailable = `Previous remote content could not be read (${error.code}).`
        }
        else if (error.code === 'filesystem-result-too-large' || error.code === 'file-type-denied') {
          boundaryUnavailable = `Previous remote content could not be previewed (${error.code}).`
          observationUnavailable = boundaryUnavailable
        } else throw error
      }
    }

    context.signal.throwIfAborted()
    await executeRemoteFilesystemText(
      remoteFilesystemTarget(context),
      FILESYSTEM_WRITE_OPERATION,
      { path, content: nextContent, mode },
    )
    const resultingContent = mode === 'append' && existing !== undefined ? existing + content : nextContent
    const change = await recordFileWrite(context, { path, mode: edit ? 'edit' : mode === 'append' ? 'append' : 'write',
      before: existing, after: resultingContent, unavailable: observationUnavailable })
    context.signal.throwIfAborted()
    return formatWriteResult({
      mode: edit ? 'edit' : mode === 'append' ? 'append' : 'write', change,
      lineChanges: existing !== undefined
        ? countLineChanges(existing, resultingContent)
        : { unavailable: observationUnavailable ?? 'Previous remote file text was not observed.' },
      edit, unchanged: existing === resultingContent,
      global: flags.includes('g'),
    })
  }

  private resolve(p: string, context?: ExecutionContext): string {
    return resolveAgentPath(this.workspace, context?.cwd ?? this.workspace, p)
  }

  private checkWriteAllowed(
    filePath: string,
  ): string | null {
    if (this.restrictToWorkspace && !isWithinPath(this.workspace, filePath)) {
      return 'Error: write restricted to workspace directory'
    }
    return null
  }
}

function remoteFilesystemTarget(context: ExecutionContext) {
  const remote = context.remoteWorkdir
  if (!remote) throw new Error('Remote workdir is unavailable')
  return {
    ...remote,
    sessionId: context.sessionId,
    turnId: context.messageId,
    signal: context.signal,
  }
}
