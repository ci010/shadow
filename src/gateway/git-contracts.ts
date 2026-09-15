export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechanged'
export interface GitChange { path: string; originalPath?: string; status: GitChangeKind }
export interface GitStatus {
  available: boolean
  reason?: 'not_repository' | 'remote_unsupported' | 'git_unavailable'
  entries: GitChange[]
}
export interface GitHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}
export interface GitDiff extends GitChange {
  sourcePath?: string
  base: 'HEAD' | 'empty'
  binary: boolean
  truncated: boolean
  hunks: GitHunk[]
  oldContent?: string
  newContent?: string
  notice?: string
}

const kinds = ['modified', 'added', 'deleted', 'renamed', 'untracked', 'conflicted', 'typechanged']
const reasons = ['not_repository', 'remote_unsupported', 'git_unavailable']
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
export function isGitFilePath(value: unknown): value is string {
  return typeof value === 'string' && !!value && !/[\0\\:]/.test(value)
    && value.split('/').every(part => !!part && part !== '.' && part !== '..' && part.toLowerCase() !== '.git')
}
function change(value: unknown): value is GitChange {
  return record(value) && isGitFilePath(value.path) && typeof value.status === 'string' && kinds.includes(value.status)
    && (value.originalPath === undefined || isGitFilePath(value.originalPath))
}
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function hunk(value: unknown): value is GitHunk {
  return record(value) && nonnegative(value.oldStart) && nonnegative(value.oldLines)
    && nonnegative(value.newStart) && nonnegative(value.newLines) && Array.isArray(value.lines)
    && value.lines.every(line => typeof line === 'string' && /^[ +\\-]/.test(line))
    && value.lines.filter(line => /^[ -]/.test(line)).length === value.oldLines
    && value.lines.filter(line => /^[ +]/.test(line)).length === value.newLines
}
function copyChange(value: GitChange): GitChange {
  return { path: value.path, status: value.status, ...(value.originalPath !== undefined ? { originalPath: value.originalPath } : {}) }
}
export function parseGitStatus(value: unknown): GitStatus {
  if (!record(value) || typeof value.available !== 'boolean' || !Array.isArray(value.entries) || value.entries.length > 5000 || !value.entries.every(change)
    || (value.reason !== undefined && !reasons.includes(String(value.reason)))) throw new Error('Invalid Git status received. Refresh to retry.')
  if (!value.available && value.entries.length) throw new Error('Unavailable Git status included file changes. Refresh to retry.')
  return { available: value.available, entries: value.entries.map(copyChange), ...(value.reason ? { reason: value.reason as GitStatus['reason'] } : {}) }
}
export function parseGitDiff(value: unknown, expectedPath: string): GitDiff {
  if (!change(value) || value.path !== expectedPath || !record(value) || !['HEAD', 'empty'].includes(String(value.base))
    || typeof value.binary !== 'boolean' || typeof value.truncated !== 'boolean'
    || ['sourcePath', 'notice', 'oldContent', 'newContent'].some(key => value[key] !== undefined && typeof value[key] !== 'string')
    || !Array.isArray(value.hunks) || !value.hunks.every(hunk)) throw new Error('Invalid file diff received. Refresh to retry.')
  return { ...copyChange(value), base: value.base as GitDiff['base'], binary: value.binary, truncated: value.truncated,
    hunks: value.hunks.map(hunk => ({ oldStart: hunk.oldStart, oldLines: hunk.oldLines, newStart: hunk.newStart, newLines: hunk.newLines, lines: hunk.lines })),
    ...(typeof value.sourcePath === 'string' ? { sourcePath: value.sourcePath } : {}),
    ...(typeof value.notice === 'string' ? { notice: value.notice } : {}),
    ...(typeof value.oldContent === 'string' ? { oldContent: value.oldContent } : {}),
    ...(typeof value.newContent === 'string' ? { newContent: value.newContent } : {}) }
}
