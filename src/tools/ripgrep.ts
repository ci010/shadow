import { isAbsolute, posix, relative, resolve } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { stat as nodeStat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import type { ExecutionContext } from './context.ts'
import { isNotFoundError } from '../utils/runtime.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { Tool, ToolParameters } from './tool.ts'
import { isVirtualPath, type VirtualFs, type VirtualEntry } from '../vfs/virtual-fs.ts'

export { detectRipgrep, installRipgrep } from '../utils/ripgrep.ts'

const MAX_LINE_LENGTH = 2000

async function spawnRg(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; exitCode: number }> {
  signal?.throwIfAborted()
  // Apply exclusions last so an include glob cannot re-enable OS artifacts.
  // Windows device names can exist as directory entries (e.g. via POSIX tools),
  // but opening them through ordinary Win32 paths can fail the entire search.
  const artifactGlobs = ['--glob=!.DS_Store']
  if (process.platform === 'win32') {
    for (const name of ['nul', 'con', 'prn', 'aux', 'com[1-9¹²³]', 'lpt[1-9¹²³]', 'conin$', 'conout$']) {
      artifactGlobs.push(`--iglob=!${name}`, `--iglob=!${name}.*`)
    }
  }
  const proc = childSpawn('rg', [...args, ...artifactGlobs], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const onAbort = () => {
    try {
      proc.kill()
    } catch { /* already exited */ }
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    // Collect stdout chunks and wait for both stream end and process exit.
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stderr.on('data', (chunk: Buffer) => { if (stderr.length < 16_384) stderr += chunk.toString('utf8').slice(0, 16_384 - stderr.length) })
    proc.stdout?.on('data', (c: Buffer) => chunks.push(c))

    const exitCode = await new Promise<number>((resolve, reject) => {
      proc.once('error', (err) => {
        if (isNotFoundError(err)) {
          reject(
            new Error(
              'ripgrep (rg) not found in PATH. Please install it: https://github.com/BurntSushi/ripgrep',
            ),
          )
        } else {
          reject(err)
        }
      })
      proc.once('close', (code) => resolve(code ?? -1))
    })
    signal?.throwIfAborted()
    if (exitCode !== 0 && exitCode !== 1) throw new Error(`ripgrep search failed (exit ${exitCode}): ${stderr.trim() || 'No diagnostic output'}`)
    return { stdout: Buffer.concat(chunks).toString('utf8'), exitCode }
  } catch (e) {
    if (e instanceof Error && e.name === 'AbortError') throw e
    if (signal?.aborted) throw signal.reason
    throw e
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
}

async function statMtime(path: string): Promise<number> {
  try {
    const stat = await nodeStat(path)
    return stat.mtime?.getTime() ?? 0
  } catch {
    return 0
  }
}

/** Return a workspace-relative path if the file lives inside the workspace, otherwise return the absolute path. */
function displayPath(absPath: string, workspace: string): string {
  const rel = relative(workspace, absPath)
  return rel.startsWith('..') ? absPath : rel
}

// ── GlobTool ─────────────────────────────────────────────────────────────────

export class GlobTool implements Tool {
  readonly name = 'glob'
  readonly readonly = true
  readonly description =
    'Find files by glob pattern (e.g. "**/*.txt"). Returns paths sorted by modification time.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'The glob pattern to match file paths against (e.g. "**/*.txt", "reports/**", "*.log")',
      },
      path: {
        type: 'string',
        description: 'Directory to search in. Defaults to workspace root.',
      },
    },
    required: ['pattern'],
  }

  constructor(private workspace: string, private virtualFs?: VirtualFs) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const pattern = String(args.pattern)
    const rawDir = args.path ? String(args.path) : this.workspace
    const dir = displayPath(
      isAbsolute(rawDir) ? rawDir : resolve(this.workspace, rawDir),
      this.workspace,
    )
    return `glob ${JSON.stringify(pattern)} in ${dir}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const pattern = String(args.pattern)
    const rawPath = args.path ? String(args.path) : ''
    const page = virtualPage(args)

    const virtualPath = isVirtualPath(rawPath) ? rawPath
      : !rawPath && isVirtualPath(pattern) ? pattern.replace(/\\/g, '/').replace(/^\/+/, '').split('/')[0] : undefined
    if (virtualPath) {
      if (!this.virtualFs) throw new Error('Virtual filesystem search is not configured.')
      const entries = await this.virtualFs.list(virtualPath, context, { content: false })
      if (!entries) throw new Error('Unknown virtual folder.')
      const globPattern = rawPath ? pattern : pattern.replace(/\\/g, '/').replace(/^\/+/, '').slice(virtualPath.length + 1) || '**'
      const matches = entries.filter(entry => matchesGlob(entry.name, globPattern)).map(entry => entry.path)
      return virtualResults(matches, entries, page, 'No files found')
    }

    const searchDir = rawPath
      ? resolveAgentPath(this.workspace, context.cwd ?? this.workspace, rawPath)
      : (context.cwd ?? this.workspace)

    const { stdout, exitCode } = await spawnRg([
      '--files',
      '--hidden',
      '--glob=!.git/*',
      `--glob=${pattern}`,
      searchDir,
    ], context.signal)

    if (exitCode !== 0 || !stdout.trim()) {
      return 'No files found'
    }

    const rawPaths = stdout.trim().split(/\r?\n/).filter(Boolean)
    const files = await Promise.all(
      rawPaths.map(async (p) => ({ path: p, mtime: await statMtime(p) })),
    )
    files.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path))
    return virtualResults(files.map(file => file.path), [], page, 'No files found')
  }
}

// ── GrepTool ─────────────────────────────────────────────────────────────────

export class GrepTool implements Tool {
  readonly name = 'grep'
  readonly readonly = true
  readonly description =
    'Search file contents with regex. Returns matching lines with file path and line number.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'The regex pattern to search for in file contents',
      },
      path: {
        type: 'string',
        description:
          'Directory or file to search in. Defaults to workspace root.',
      },
      include: {
        type: 'string',
        description:
          'File glob pattern to restrict the search (e.g. "*.txt", "*.log", "*.md")',
      },
    },
    required: ['pattern'],
  }

  constructor(private workspace: string, private virtualFs?: VirtualFs) {}

  getChatTextDisplay(args: Record<string, unknown>): string {
    const pattern = String(args.pattern)
    const include = args.include ? ` [${String(args.include)}]` : ''
    const rawPath = args.path ? String(args.path) : this.workspace
    const dir = displayPath(
      isAbsolute(rawPath) ? rawPath : resolve(this.workspace, rawPath),
      this.workspace,
    )
    return `grep ${JSON.stringify(pattern)}${include} in ${dir}`
  }

  async execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<string> {
    const pattern = String(args.pattern)
    const page = virtualPage(args)

    if (args.path && isVirtualPath(String(args.path))) {
      const re = new RegExp(pattern)
      if (!this.virtualFs) throw new Error('Virtual filesystem search is not configured.')
      const entries = await this.virtualFs.list(String(args.path), context)
      if (!entries) throw new Error('Unknown virtual folder.')
      const matches: string[] = []
      for (const entry of entries) {
        context.signal.throwIfAborted()
        if (args.include && !matchesGlob(entry.name, String(args.include))) continue
        const lines = entry.content.split(/\r?\n/)
        for (let i = 0; i < lines.length; i++) {
          if (re.test(lines[i])) {
            const text = lines[i].length > MAX_LINE_LENGTH ? lines[i].slice(0, MAX_LINE_LENGTH) + '...' : lines[i]
            matches.push(`${entry.path}:  Line ${i + 1}: ${text}`)
          }
        }
      }
      return virtualResults(matches, entries, page, 'No matches found')
    }

    const searchPath = args.path
      ? resolveAgentPath(this.workspace, context.cwd ?? this.workspace, String(args.path))
      : (context.cwd ?? this.workspace)

    const rgArgs = [
      '-nH',
      '--hidden',
      '--field-match-separator=|',
      '--regexp',
      pattern,
    ]
    if (args.include) {
      rgArgs.push('--glob', String(args.include))
    }
    rgArgs.push(searchPath)

    const { stdout, exitCode } = await spawnRg(rgArgs, context.signal)

    if (exitCode === 1 || !stdout.trim()) {
      return 'No matches found'
    }

    const rawLines = stdout.trim().split(/\r?\n/).filter(Boolean)
    const allMatches: {
      path: string
      lineNum: number
      lineText: string
      mtime: number
    }[] = []

    for (const line of rawLines) {
      const [filePath, lineNumStr, ...rest] = line.split('|')
      if (!filePath || !lineNumStr || rest.length === 0) continue
      const lineNum = parseInt(lineNumStr, 10)
      if (isNaN(lineNum)) continue
      allMatches.push({
        path: filePath,
        lineNum,
        lineText: rest.join('|'),
        mtime: 0,
      })
    }

    // Fetch mtimes for unique files only, then assign
    const uniquePaths = [...new Set(allMatches.map((m) => m.path))]
    const mtimeMap = new Map(
      await Promise.all(
        uniquePaths.map(async (p) => [p, await statMtime(p)] as const),
      ),
    )
    for (const m of allMatches) {
      m.mtime = mtimeMap.get(m.path) ?? 0
    }

    allMatches.sort((a, b) => b.mtime - a.mtime || a.path.localeCompare(b.path) || a.lineNum - b.lineNum)

    const final = allMatches.slice(page.offset, page.offset + page.limit)
    const truncated = allMatches.length > page.offset + final.length

    if (final.length === 0) return allMatches.length ? 'No results at this offset.' : 'No matches found'

    const out: string[] = [
      `Found ${allMatches.length} match${allMatches.length !== 1 ? 'es' : ''}${
        final.length < allMatches.length ? ` (showing ${page.offset + 1}-${page.offset + final.length})` : ''
      }`,
    ]
    let currentFile = ''
    for (const m of final) {
      if (currentFile !== m.path) {
        if (currentFile !== '') out.push('')
        currentFile = m.path
        out.push(`${m.path}:`)
      }
      const text = m.lineText.length > MAX_LINE_LENGTH
        ? m.lineText.slice(0, MAX_LINE_LENGTH) + '...'
        : m.lineText
      out.push(`  Line ${m.lineNum}: ${text}`)
    }

    if (truncated) {
      out.push('')
      out.push(
        `(Showing ${final.length} of ${allMatches.length} results; continue with offset: ${page.offset + final.length}.)`,
      )
    }

    return out.join('\n')
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function matchesGlob(name: string, pattern: string): boolean {
  const normalized = pattern.replace(/\\/g, '/')
  return posix.matchesGlob(normalized.includes('/') ? name : posix.basename(name), normalized)
}

function virtualPage(args: Record<string, unknown>): { limit: number; offset: number } {
  const limit = args.limit === undefined ? 100 : args.limit
  const offset = args.offset === undefined ? 0 : args.offset
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('limit must be an integer from 1 through 100.')
  if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) throw new Error('offset must be a nonnegative safe integer.')
  return { limit, offset }
}

function virtualResults(matches: string[], entries: Array<VirtualEntry & { path: string }>, page: { limit: number; offset: number }, empty: string): string {
  const selected = matches.slice(page.offset, page.offset + page.limit)
  const lines = selected.length ? selected : [matches.length ? 'No results at this offset.' : empty]
  if (matches.length > page.offset + selected.length) lines.push(`(Showing ${selected.length} of ${matches.length} results; continue with offset: ${page.offset + selected.length}.)`)
  for (const entry of entries) {
    if (entry.warning) lines.push(`Warning: ${entry.path}: ${entry.warning}`)
  }
  return lines.join('\n')
}
