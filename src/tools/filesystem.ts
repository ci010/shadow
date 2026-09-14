import { dirname, relative, resolve } from 'node:path'
import { appendFile, mkdir, open, readFile, writeFile } from 'node:fs/promises'
import type { ExecutionContext } from '../agent/agent.ts'
import { isNotFoundError, isWindows } from '../utils/runtime.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { Tool, ToolParameters } from './tool.ts'
import {
  FILESYSTEM_READ_OPERATION,
  FILESYSTEM_WRITE_OPERATION,
} from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText, RemoteFilesystemError } from '../execution/remote-filesystem-client.ts'
import { formatWriteResult, MAX_WRITE_REGIONS, type ReplacementResult } from './write-result.ts'
import { countLineChanges, MAX_LINE_DIFF_CHARS } from './line-changes.ts'

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

// ── Edit replacers ───────────────────────────────────────────────────────────
// Cascading fuzzy-match strategies for edit mode, applied in order until one succeeds.

function getCommonIndent(lines: string[]): string {
  const nonEmpty = lines.filter((l) => l.trim().length > 0)
  if (nonEmpty.length === 0) return ''
  let common = nonEmpty[0].match(/^(\s*)/)?.[1] ?? ''
  for (let i = 1; i < nonEmpty.length; i++) {
    const indent = nonEmpty[i].match(/^(\s*)/)?.[1] ?? ''
    let j = 0
    while (j < common.length && j < indent.length && common[j] === indent[j]) {
      j++
    }
    common = common.slice(0, j)
  }
  return common
}

/** Strategy 1 — exact string match. */
function SimpleReplacer(
  content: string,
  oldStr: string,
  newStr: string,
  replaceAll: boolean,
): ReplacementResult | null {
  const idx = content.indexOf(oldStr)
  if (idx === -1) return null
  if (replaceAll) {
    let count = 0
    let delta = 0
    const ranges: ReplacementResult['ranges'] = []
    const updated = content.replaceAll(oldStr, (_match, offset: number) => {
      const start = offset + delta
      if (ranges.length < MAX_WRITE_REGIONS) ranges.push({ start, end: start + newStr.length })
      count++
      delta += newStr.length - oldStr.length
      return newStr
    })
    return { content: updated, strategy: 'exact', count, ranges }
  }
  return {
    content: content.slice(0, idx) + newStr + content.slice(idx + oldStr.length),
    strategy: 'exact', count: 1, ranges: [{ start: idx, end: idx + newStr.length }],
  }
}

/** Strategy 2 — match after trimming each line. Tolerates trailing/leading space differences. */
function LineTrimmedReplacer(
  content: string,
  oldStr: string,
  newStr: string,
): ReplacementResult | null {
  const contentLines = content.split('\n')
  const oldLines = oldStr.split('\n')
  const n = oldLines.length
  const trimmedOld = oldLines.map((l) => l.trim())

  for (let i = 0; i <= contentLines.length - n; i++) {
    const window = contentLines.slice(i, i + n)
    if (window.every((line, j) => line.trim() === trimmedOld[j])) {
      const start = contentLines.slice(0, i).reduce((offset, line) => offset + line.length + 1, 0)
      return { content: [
        ...contentLines.slice(0, i),
        ...newStr.split('\n'),
        ...contentLines.slice(i + n),
      ].join('\n'), strategy: 'line-trimmed', count: 1, ranges: [{ start, end: start + newStr.length }] }
    }
  }
  return null
}

/** Strategy 3 — strip common leading indentation before comparing, then re-indent. */
function IndentationFlexibleReplacer(
  content: string,
  oldStr: string,
  newStr: string,
): ReplacementResult | null {
  const contentLines = content.split('\n')
  const oldLines = oldStr.split('\n')
  const n = oldLines.length
  const commonOldIndent = getCommonIndent(oldLines)
  const strippedOld = oldLines.map((l) =>
    l.trim()
      ? (l.startsWith(commonOldIndent) ? l.slice(commonOldIndent.length) : l)
      : ''
  )

  for (let i = 0; i <= contentLines.length - n; i++) {
    const window = contentLines.slice(i, i + n)
    const commonWindowIndent = getCommonIndent(window)
    if (commonWindowIndent === commonOldIndent) continue // same indent — SimpleReplacer would have caught this
    const strippedWindow = window.map((l) =>
      l.trim()
        ? (l.startsWith(commonWindowIndent)
          ? l.slice(commonWindowIndent.length)
          : l)
        : ''
    )
    if (strippedWindow.join('\n') === strippedOld.join('\n')) {
      const newLines = newStr.split('\n').map((l) => {
        if (!l.trim()) return l
        const stripped = l.startsWith(commonOldIndent)
          ? l.slice(commonOldIndent.length)
          : l
        return commonWindowIndent + stripped
      })
      const start = contentLines.slice(0, i).reduce((offset, line) => offset + line.length + 1, 0)
      return { content: [
        ...contentLines.slice(0, i),
        ...newLines,
        ...contentLines.slice(i + n),
      ].join('\n'), strategy: 'indentation-flexible', count: 1, ranges: [{ start, end: start + newLines.join('\n').length }] }
    }
  }
  return null
}

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
  // Normalize line endings before all comparisons
  const nc = content.replace(/\r\n/g, '\n')
  const no = oldStr.replace(/\r\n/g, '\n')
  const nn = newStr.replace(/\r\n/g, '\n')
  return SimpleReplacer(nc, no, nn, replaceAll) ??
    LineTrimmedReplacer(nc, no, nn) ??
    IndentationFlexibleReplacer(nc, no, nn)
}

// ── Unified write tool ────────────────────────────────────────────────────────

export class WriteTool implements Tool {
  readonly name = 'write'
  readonly supportsRemoteWorkdir = true
  readonly description =
    'Write or edit a file. With `match`: find and replace. Creates directories as needed.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: {
        type: 'string',
        description: 'Full file content, or replacement text when match is set',
      },
      match: {
        type: 'string',
        description: 'Exact text to find for edit mode',
      },
      flag: {
        type: 'string',
        description: 'g = replace all occurrences, a = append to file',
      },
    },
    required: ['path', 'content'],
  }

  constructor(
    private workspace: string,
    private selfCodeRoot?: string,
    private restrictToWorkspace: boolean = false,
  ) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const filePath = this.resolve(String(args.path))
    const icon = args.match ? '✏️' : '📝'
    return `${icon} ${displayPath(filePath, this.workspace)}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    context.signal.throwIfAborted()
    if (context.remoteWorkdir) {
      return await this.writeRemote(args, context)
    }
    const filePath = this.resolve(String(args.path), context)
    const restriction = this.checkWriteAllowed(filePath, context)
    if (restriction) return restriction

    const content = String(args.content)
    const flags = typeof args.flag === 'string' ? args.flag : ''
    const match = args.match != null ? String(args.match) : undefined

    if (match !== undefined) {
      // ── Edit mode: find and replace ──
      let existing: string
      try {
        existing = await readFile(filePath, { encoding: 'utf8', signal: context.signal })
      } catch (error) {
        if (!isNotFoundError(error)) throw error
        return `Error: file not found: ${filePath}`
      }
      context.signal.throwIfAborted()
      const replaceAll = flags.includes('g')
      const updated = applyReplacementDetailed(existing, match, content, replaceAll)
      if (updated === null) {
        return 'Error: match string not found in file'
      }
      context.signal.throwIfAborted()
      await writeFile(filePath, updated.content)
      context.signal.throwIfAborted()
      return formatWriteResult({
        path: filePath, mode: 'edit', content: updated.content, writtenBytes: Buffer.byteLength(updated.content),
        edit: updated, unchanged: existing === updated.content, normalizedNewlines: existing.includes('\r\n'), global: replaceAll,
        lineChanges: countLineChanges(existing, updated.content),
      })
    }

    if (flags.includes('a')) {
      // ── Append mode ──
      let existing = ''
      try {
        existing = await readFile(filePath, { encoding: 'utf8', signal: context.signal })
      } catch (error) {
        if (!isNotFoundError(error)) throw error
      }
      context.signal.throwIfAborted()
      await mkdir(dirname(filePath), { recursive: true })
      context.signal.throwIfAborted()
      await appendFile(filePath, content)
      context.signal.throwIfAborted()
      return formatWriteResult({
        path: filePath, mode: 'append', content: existing + content, appendStart: existing.length,
        writtenBytes: Buffer.byteLength(content),
        lineChanges: countLineChanges(existing, existing + content),
      })
    }

    // ── Full write mode ──
    const before = await observeBeforeOverwrite(filePath, context.signal)
    context.signal.throwIfAborted()
    await mkdir(dirname(filePath), { recursive: true })
    context.signal.throwIfAborted()
    await writeFile(filePath, content)
    context.signal.throwIfAborted()
    return formatWriteResult({
      path: filePath, mode: 'write', content, writtenBytes: Buffer.byteLength(content),
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
      if (updated === null) return 'Error: match string not found in file'
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
    context.signal.throwIfAborted()
    const resultingContent = mode === 'append' && existing !== undefined ? existing + content : nextContent
    return formatWriteResult({
      path, mode: edit ? 'edit' : mode === 'append' ? 'append' : 'write',
      content: resultingContent,
      lineChanges: existing !== undefined
        ? countLineChanges(existing, resultingContent)
        : { unavailable: observationUnavailable ?? 'Previous remote file text was not observed.' },
      writtenBytes: Buffer.byteLength(nextContent), edit,
      appendStart: mode === 'append' && existing !== undefined ? existing.length : undefined,
      boundaryUnavailable, unchanged: edit ? existing === nextContent : undefined,
      normalizedNewlines: edit ? existing?.includes('\r\n') : undefined, global: flags.includes('g'),
    })
  }

  private resolve(p: string, context?: ExecutionContext): string {
    return resolveAgentPath(this.workspace, context?.cwd ?? this.workspace, p)
  }

  private checkWriteAllowed(
    filePath: string,
    context: ExecutionContext,
  ): string | null {
    if (this.restrictToWorkspace && !isWithinPath(this.workspace, filePath)) {
      return 'Error: write restricted to workspace directory'
    }
    if (
      this.selfCodeRoot && isWithinPath(this.selfCodeRoot, filePath) &&
      !context.admin
    ) {
      return 'Error: write to src/ is restricted to admin sessions.'
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
