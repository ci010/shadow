import { isAbsolute, relative, resolve } from 'node:path'
import { spawn as childSpawn } from 'node:child_process'
import { stat as nodeStat } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import type { ExecutionContext } from '../agent/agent.ts'
import { isNotFoundError } from '../utils/runtime.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import type { Tool, ToolParameters } from './tool.ts'
import type { VirtualFs } from '../vfs/virtual-fs.ts'

export { detectRipgrep, installRipgrep } from '../utils/ripgrep.ts'

const GLOB_LIMIT = 100
const GREP_LIMIT = 100
const MAX_LINE_LENGTH = 2000

async function spawnRg(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; exitCode: number }> {
  signal?.throwIfAborted()
  const proc = childSpawn('rg', args, {
    stdio: ['ignore', 'pipe', 'ignore'],
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

    // ── Virtual filesystem ──
    if (this.virtualFs) {
      // Case 1: path="v:sessions" pattern="*" → list entries under v:sessions
      // Case 2: path not set, pattern="v:sessions/*" → extract mount from pattern
      const rel = rawPath
        ? (isAbsolute(rawPath) ? relative(this.workspace, rawPath) : rawPath)
        : ''
      const mount = rel || pattern.split('/')[0]
      if (!mount.startsWith('..')) {
        const entries = this.virtualFs.list(mount, context)
        if (entries) {
          const list = await entries
          const globPattern = rel ? pattern : pattern.slice(mount.length + 1) || '*'
          const globRe = globToRegex(globPattern)
          const matched = list.filter((e) => globRe.test(e.name))
          if (matched.length === 0) return 'No files found'
          return matched.map((e) => `${mount}/${e.name}`).join('\n')
        }
      }
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
    const truncated = rawPaths.length > GLOB_LIMIT
    const limited = rawPaths.slice(0, GLOB_LIMIT)

    const files = await Promise.all(
      limited.map(async (p) => ({ path: p, mtime: await statMtime(p) })),
    )
    files.sort((a, b) => b.mtime - a.mtime)

    const lines: string[] = files.map((f) => f.path)
    if (truncated) {
      lines.push('')
      lines.push(
        `(Results are truncated: showing first ${GLOB_LIMIT} results. Consider using a more specific path or pattern.)`,
      )
    }

    return lines.join('\n')
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

    // ── Virtual filesystem ──
    if (this.virtualFs && args.path) {
      const rawPath = String(args.path)
      const rel = isAbsolute(rawPath)
        ? relative(this.workspace, rawPath)
        : rawPath
      if (!rel.startsWith('..')) {
        const entries = this.virtualFs.list(rel, context)
        if (entries) {
          const list = await entries
          const re = new RegExp(pattern, 'i')
          const matches: string[] = []
          for (const entry of list) {
            const lines = entry.content.split('\n')
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                const text = lines[i].length > MAX_LINE_LENGTH
                  ? lines[i].slice(0, MAX_LINE_LENGTH) + '...'
                  : lines[i]
                matches.push(`${rel}/${entry.name}:  Line ${i + 1}: ${text}`)
              }
            }
          }
          if (matches.length === 0) return 'No matches found'
          return `Found ${matches.length} match${matches.length !== 1 ? 'es' : ''}\n` +
            matches.slice(0, GREP_LIMIT).join('\n')
        }
      }
    }

    const searchPath = args.path
      ? resolveAgentPath(this.workspace, context.cwd ?? this.workspace, String(args.path))
      : (context.cwd ?? this.workspace)

    const rgArgs = [
      '-nH',
      '--hidden',
      '--no-messages',
      '--field-match-separator=|',
      '--regexp',
      pattern,
    ]
    if (args.include) {
      rgArgs.push('--glob', String(args.include))
    }
    rgArgs.push(searchPath)

    const { stdout, exitCode } = await spawnRg(rgArgs, context.signal)

    // Exit codes: 0 = matches found, 1 = no matches, 2 = partial errors (still usable)
    if (exitCode === 1 || (exitCode === 2 && !stdout.trim())) {
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

    allMatches.sort((a, b) => b.mtime - a.mtime || a.lineNum - b.lineNum)

    const truncated = allMatches.length > GREP_LIMIT
    const final = truncated ? allMatches.slice(0, GREP_LIMIT) : allMatches

    if (final.length === 0) return 'No matches found'

    const out: string[] = [
      `Found ${allMatches.length} match${allMatches.length !== 1 ? 'es' : ''}${
        truncated ? ` (showing first ${GREP_LIMIT})` : ''
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
        `(Results truncated: showing ${GREP_LIMIT} of ${allMatches.length} matches. Consider using a more specific path or pattern.)`,
      )
    }

    return out.join('\n')
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Convert a simple glob pattern to a RegExp. Supports `*` and `?`. */
function globToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const re = escaped
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '.')
  return new RegExp(`^${re}$`)
}
