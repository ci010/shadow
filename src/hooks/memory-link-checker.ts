/**
 * Post-write linter for markdown files under the workspace `memory/` folder.
 *
 * Implemented as a {@link ToolExecutionHook} so the registry calls it
 * automatically after `write` touches a memory
 * markdown file.  The diagnostic report is appended to the tool result —
 * similar to how a typecheck diagnostic would appear.
 *
 * Checks performed:
 * 1. **Unlinked file paths** – inline code (`path/to/file`) that should
 *    be a markdown link (`[file](path/to/file)`).
 * 2. **Dead links** – markdown links whose target file does not exist.
 * 3. **Absolute workspace paths** – auto-converted to workspace-relative
 *    and reported.
 */

import {
  dirname,
  extname,
  isAbsolute,
  normalize,
  relative,
  resolve,
} from 'node:path'
import { readFile, stat, writeFile } from 'node:fs/promises'
import type { ToolExecutionHook } from '../tools/tool.ts'
import type { ExecutionContext } from '../agent/agent.ts'
import { dealiasMemoryPath } from '../utils/paths.ts'

// ── helpers ──────────────────────────────────────────────────────────

const KNOWN_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.json',
  '.jsonl',
  '.jsonc',
  '.md',
  '.mdx',
  '.txt',
  '.csv',
  '.yml',
  '.yaml',
  '.toml',
  '.ini',
  '.cfg',
  '.bat',
  '.sh',
  '.ps1',
  '.cmd',
  '.py',
  '.rb',
  '.rs',
  '.go',
  '.java',
  '.kt',
  '.c',
  '.cpp',
  '.h',
  '.css',
  '.scss',
  '.less',
  '.html',
  '.htm',
  '.vue',
  '.svelte',
  '.xml',
  '.svg',
  '.sql',
  '.env',
  '.lock',
  '.log',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.wasm',
  '.zip',
  '.tar',
  '.gz',
])

/** Tools that may write files and should trigger memory-link checks. */
const WRITE_TOOLS = new Set(['write'])

function hasKnownExtension(s: string): boolean {
  const ext = extname(s).toLowerCase()
  return ext.length > 0 && KNOWN_EXTENSIONS.has(ext)
}

/** Heuristic: does this inline-code string look like a file path? */
function looksLikeFilePath(s: string): boolean {
  const t = s.trim()
  if (!t || t.includes(' ') || t.includes('\t')) return false
  if (/^https?:\/\//.test(t)) return false
  if (t.startsWith('#')) return false
  if (hasKnownExtension(t)) return true
  // Has path separators and looks path-like
  if (/[/\\]/.test(t) && /^[\w.\-/\\:~]+$/.test(t)) return true
  return false
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** Normalise a directory path and ensure it ends with a separator. */
function normalizeDir(dir: string): string {
  const n = normalize(dir)
  return n.endsWith('\\') || n.endsWith('/') ? n : n + '\\'
}

/** Whether a resolved absolute path is a `.md` file inside `<workspace>/memory/`. */
function isMemoryMarkdownFile(
  resolvedPath: string,
  workspace: string,
): boolean {
  const norm = normalize(resolvedPath)
  const memDir = normalizeDir(resolve(workspace, 'memory'))
  return norm.startsWith(memDir) && norm.endsWith('.md')
}

// ── lint logic ───────────────────────────────────────────────────────

interface Diagnostic {
  line: number
  message: string
}

/**
 * Lint a markdown file that lives under the workspace `memory/` folder.
 *
 * @param content  The current file content (just written to disk).
 * @param filePath Absolute path of the memory markdown file.
 * @param workspace Absolute path of the workspace root.
 * @returns `report` to append to the tool result, and `fixedContent` if
 *          any automatic corrections were applied (absolute → relative).
 */
async function checkMemoryMarkdown(
  content: string,
  filePath: string,
  workspace: string,
): Promise<{ report: string; fixedContent: string | null }> {
  const diagnostics: Diagnostic[] = []
  const lines = content.split('\n')
  let modified = false
  let inFenced = false

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]

    // Track fenced code blocks
    if (/^\s*```/.test(line)) {
      inFenced = !inFenced
      continue
    }
    if (inFenced) continue

    // ── 1. Markdown links: dead-link & absolute-path checks ──────────

    const linkRe = /\[([^\]]*)\]\(([^)\s]+)\)/g
    let m: RegExpExecArray | null
    while ((m = linkRe.exec(line)) !== null) {
      const linkText = m[1]
      const linkTarget = m[2]

      // Skip URLs / anchors / mailto
      if (/^(https?:\/\/|#|mailto:)/.test(linkTarget)) continue

      // Absolute path inside workspace → auto-convert to relative
      if (isAbsolute(linkTarget)) {
        const normTarget = normalize(linkTarget)
        const wsPrefix = normalizeDir(workspace)
        if (
          normTarget.startsWith(wsPrefix) || normTarget === normalize(workspace)
        ) {
          const rel = relative(workspace, normTarget).replace(/\\/g, '/')
          line = line.replace(linkTarget, rel)
          lines[i] = line
          modified = true
          diagnostics.push({
            line: i + 1,
            message:
              `Converted absolute path → relative: ${linkTarget} → ${rel}`,
          })
          // Check the newly-relative path for existence
          if (!(await fileExists(resolve(workspace, rel)))) {
            diagnostics.push({
              line: i + 1,
              message: `Dead link: [${linkText}](${rel}) — file not found`,
            })
          }
          continue
        }
      }

      // Dead-link check: try workspace-relative first, then file-relative
      if (!isAbsolute(linkTarget)) {
        const wsResolved = resolve(workspace, linkTarget)
        const fileResolved = resolve(dirname(filePath), linkTarget)
        if (
          !(await fileExists(wsResolved)) && !(await fileExists(fileResolved))
        ) {
          diagnostics.push({
            line: i + 1,
            message: `Dead link: [${linkText}](${linkTarget}) — file not found`,
          })
        }
      } else {
        // Absolute path NOT inside workspace — just check existence
        if (!(await fileExists(linkTarget))) {
          diagnostics.push({
            line: i + 1,
            message: `Dead link: [${linkText}](${linkTarget}) — file not found`,
          })
        }
      }
    }

    // ── 2. Inline code: unlinked file-path detection ─────────────────

    // Collect all markdown-link spans so we can skip code inside them
    const linkSpans: Array<[number, number]> = []
    const spanRe = /\[[^\]]*\]\([^)]*\)/g
    let ls: RegExpExecArray | null
    while ((ls = spanRe.exec(line)) !== null) {
      linkSpans.push([ls.index, ls.index + ls[0].length])
    }

    const codeRe = /`([^`]+)`/g
    let cm: RegExpExecArray | null
    while ((cm = codeRe.exec(line)) !== null) {
      const code = cm[1]
      if (!looksLikeFilePath(code)) continue

      // Skip when the code span lives inside a markdown link
      const start = cm.index
      const end = start + cm[0].length
      if (linkSpans.some(([a, b]) => start >= a && end <= b)) continue

      diagnostics.push({
        line: i + 1,
        message:
          `File path in code span should be a markdown link: \`${code}\` → [${code}](${code})`,
      })
    }
  }

  if (diagnostics.length === 0) {
    return { report: '', fixedContent: null }
  }

  const parts = ['\n📎 Memory link check:']
  for (const d of diagnostics) {
    parts.push(`  L${d.line}: ${d.message}`)
  }

  return {
    report: parts.join('\n'),
    fixedContent: modified ? lines.join('\n') : null,
  }
}

// ── hook implementation ──────────────────────────────────────────────

/**
 * {@link ToolExecutionHook} that lints memory markdown files after writes.
 *
 * Register on a {@link ToolRegistry} via `registry.addHook(new MemoryLinkCheckHook(workspace))`.
 */
export class MemoryLinkCheckHook implements ToolExecutionHook {
  readonly name = 'memory-link-check'

  constructor(private workspace: string) {}

  async afterExecute(
    toolName: string,
    args: Record<string, unknown>,
    _result: string,
    _context: ExecutionContext,
  ): Promise<string | undefined> {
    if (!WRITE_TOOLS.has(toolName)) return undefined

    // Collect all file paths touched by the tool call
    const paths: string[] = []
    if (args.path) paths.push(String(args.path))
    if (Array.isArray(args.files)) {
      for (const f of args.files as Array<{ path?: string }>) {
        if (f.path) paths.push(String(f.path))
      }
    }
    if (Array.isArray(args.edits)) {
      for (const e of args.edits as Array<{ path?: string }>) {
        if (e.path) paths.push(String(e.path))
      }
    }

    const reports: string[] = []
    const seen = new Set<string>()
    for (const p of paths) {
      const dealiased = dealiasMemoryPath(p)
      const resolved = isAbsolute(dealiased)
        ? dealiased
        : resolve(this.workspace, dealiased)
      if (seen.has(resolved)) continue
      seen.add(resolved)
      if (!isMemoryMarkdownFile(resolved, this.workspace)) continue

      try {
        const content = await readFile(resolved, 'utf8')
        const { report, fixedContent } = await checkMemoryMarkdown(
          content,
          resolved,
          this.workspace,
        )
        if (fixedContent !== null) {
          await writeFile(resolved, fixedContent)
        }
        if (report) reports.push(report)
      } catch { /* file access error — skip */ }
    }

    const combined = reports.join('')
    return combined || undefined
  }
}
