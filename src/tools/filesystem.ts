import { dirname, relative, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { ExecutionContext } from '../agent/agent.ts'
import { isWindows } from '../utils/runtime.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { Tool, ToolParameters } from './tool.ts'
import {
  FILESYSTEM_READ_OPERATION,
  FILESYSTEM_WRITE_OPERATION,
} from '../execution/capability-filesystem.ts'
import { executeRemoteFilesystemText } from '../execution/remote-filesystem-client.ts'

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
): string | null {
  const idx = content.indexOf(oldStr)
  if (idx === -1) return null
  if (replaceAll) {
    return content.replaceAll(oldStr, newStr)
  }
  return content.slice(0, idx) + newStr + content.slice(idx + oldStr.length)
}

/** Strategy 2 — match after trimming each line. Tolerates trailing/leading space differences. */
function LineTrimmedReplacer(
  content: string,
  oldStr: string,
  newStr: string,
): string | null {
  const contentLines = content.split('\n')
  const oldLines = oldStr.split('\n')
  const n = oldLines.length
  const trimmedOld = oldLines.map((l) => l.trim())

  for (let i = 0; i <= contentLines.length - n; i++) {
    const window = contentLines.slice(i, i + n)
    if (window.every((line, j) => line.trim() === trimmedOld[j])) {
      return [
        ...contentLines.slice(0, i),
        ...newStr.split('\n'),
        ...contentLines.slice(i + n),
      ].join('\n')
    }
  }
  return null
}

/** Strategy 3 — strip common leading indentation before comparing, then re-indent. */
function IndentationFlexibleReplacer(
  content: string,
  oldStr: string,
  newStr: string,
): string | null {
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
      return [
        ...contentLines.slice(0, i),
        ...newLines,
        ...contentLines.slice(i + n),
      ].join('\n')
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
        existing = await readFile(filePath, 'utf8')
      } catch {
        return `Error: file not found: ${filePath}`
      }
      const replaceAll = flags.includes('g')
      const updated = applyReplacement(existing, match, content, replaceAll)
      if (updated === null) {
        return 'Error: match string not found in file'
      }
      await writeFile(filePath, updated)
      return `✏️ ${filePath}`
    }

    if (flags.includes('a')) {
      // ── Append mode ──
      let existing = ''
      try {
        existing = await readFile(filePath, 'utf8')
      } catch {
        // File doesn't exist yet — will create
      }
      await mkdir(dirname(filePath), { recursive: true })
      await writeFile(filePath, existing + content)
      return `📝 ${filePath} (appended)`
    }

    // ── Full write mode ──
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
    return `📝 ${filePath}`
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

    if (match !== undefined) {
      const existing = await executeRemoteFilesystemText(
        remoteFilesystemTarget(context),
        FILESYSTEM_READ_OPERATION,
        { path },
      )
      const updated = applyReplacement(
        existing,
        match,
        content,
        flags.includes('g'),
      )
      if (updated === null) return 'Error: match string not found in file'
      nextContent = updated
      mode = 'replace'
    }

    await executeRemoteFilesystemText(
      remoteFilesystemTarget(context),
      FILESYSTEM_WRITE_OPERATION,
      { path, content: nextContent, mode },
    )
    return match !== undefined
      ? `✏️ ${path}`
      : flags.includes('a')
      ? `📝 ${path} (appended)`
      : `📝 ${path}`
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
