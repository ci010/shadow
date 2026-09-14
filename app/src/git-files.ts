import type { FileEntry } from './composables/useSessionFiles.ts'

export type GitChangeKind = 'modified' | 'added' | 'deleted' | 'renamed' | 'untracked' | 'conflicted' | 'typechanged'
export interface GitChange {
  path: string
  originalPath?: string
  status: GitChangeKind
}
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
export interface GitDiff {
  sourcePath?: string
  path: string
  originalPath?: string
  status: GitChangeKind
  base: 'HEAD' | 'empty'
  binary: boolean
  truncated: boolean
  hunks: GitHunk[]
  notice?: string
}

const kinds: readonly GitChangeKind[] = ['conflicted', 'modified', 'typechanged', 'deleted', 'renamed', 'added', 'untracked']
const reasons = ['not_repository', 'remote_unsupported', 'git_unavailable']
const badges: Record<GitChangeKind, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!', typechanged: 'T',
}
const labels: Record<GitChangeKind, string> = {
  modified: 'Modified', added: 'Added', deleted: 'Deleted', renamed: 'Renamed',
  untracked: 'Untracked', conflicted: 'Conflicted', typechanged: 'Type changed',
}
export function gitChangeLabel(status: GitChangeKind): string { return labels[status] }
export function gitChangeBadge(status: GitChangeKind): string { return badges[status] }

export function gitDecoration(path: string, directory: boolean, changes: readonly GitChange[]): GitChangeKind | undefined {
  if (!directory) return changes.find(change => change.path === path)?.status
  const statuses = new Set(changes.filter(change => change.path.startsWith(`${path}/`)).map(change => change.status))
  return kinds.find(kind => statuses.has(kind))
}

/** Build one directory level from Git paths, including deleted files missing on disk. */
export function changedDirectory(changes: readonly GitChange[], dir = ''): FileEntry[] {
  const prefix = dir ? `${dir}/` : ''
  const entries = new Map<string, FileEntry>()
  for (const change of changes) {
    if (!change.path.startsWith(prefix)) continue
    const rest = change.path.slice(prefix.length)
    const slash = rest.indexOf('/')
    const name = slash < 0 ? rest : rest.slice(0, slash)
    if (!name) continue
    const type = slash < 0 ? 'file' : 'dir'
    const dot = name.lastIndexOf('.')
    if (!entries.has(name) || type === 'dir') entries.set(name, {
      name, type, ext: type === 'file' && dot > 0 ? name.slice(dot).toLowerCase() : '', size: 0, mtime: null,
    })
  }
  return [...entries.values()].sort((a, b) =>
    (a.type === b.type ? 0 : a.type === 'dir' ? -1 : 1) || a.name.localeCompare(b.name))
}

export interface DiffLine {
  kind: 'context' | 'added' | 'removed' | 'note'
  text: string
  oldLine?: number
  newLine?: number
}
export function diffLines(hunk: GitHunk): DiffLine[] {
  let oldLine = hunk.oldStart
  let newLine = hunk.newStart
  return hunk.lines.map(line => {
    if (line.startsWith('+')) return { kind: 'added', text: line.slice(1), newLine: newLine++ }
    if (line.startsWith('-')) return { kind: 'removed', text: line.slice(1), oldLine: oldLine++ }
    if (line.startsWith(' ')) return { kind: 'context', text: line.slice(1), oldLine: oldLine++, newLine: newLine++ }
    return { kind: 'note', text: line }
  })
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function path(value: unknown): value is string {
  return typeof value === 'string' && !!value && !value.includes('\0') && !value.includes('\\')
    && value.split('/').every(part => !!part && part !== '.' && part !== '..')
}
function kind(value: unknown): value is GitChangeKind {
  return typeof value === 'string' && kinds.some(kind => kind === value)
}
function change(value: unknown): value is GitChange {
  return record(value) && path(value.path) && kind(value.status)
    && (value.originalPath === undefined || path(value.originalPath))
}
function nonnegative(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) >= 0 }
function hunk(value: unknown): value is GitHunk {
  return record(value) && nonnegative(value.oldStart) && nonnegative(value.oldLines)
    && nonnegative(value.newStart) && nonnegative(value.newLines) && Array.isArray(value.lines)
    && value.lines.every(line => typeof line === 'string' && /^[ +\\-]/.test(line))
    && value.lines.filter(line => /^[ -]/.test(line)).length === value.oldLines
    && value.lines.filter(line => /^[ +]/.test(line)).length === value.newLines
}
export function parseGitStatus(value: unknown): GitStatus {
  if (!record(value) || typeof value.available !== 'boolean' || !Array.isArray(value.entries) || !value.entries.every(change)
    || (value.reason !== undefined && !reasons.includes(String(value.reason)))) throw new Error('Invalid Git status received. Refresh to retry.')
  if (!value.available && value.entries.length) throw new Error('Unavailable Git status included file changes. Refresh to retry.')
  return { available: value.available, entries: value.entries, ...(value.reason ? { reason: value.reason as GitStatus['reason'] } : {}) }
}
export function parseGitDiff(value: unknown, expectedPath: string): GitDiff {
  if (!change(value) || value.path !== expectedPath || !record(value) || !['HEAD', 'empty'].includes(String(value.base))
    || typeof value.binary !== 'boolean' || typeof value.truncated !== 'boolean'
    || (value.sourcePath !== undefined && typeof value.sourcePath !== 'string')
    || (value.notice !== undefined && typeof value.notice !== 'string')
    || !Array.isArray(value.hunks) || !value.hunks.every(hunk)) throw new Error('Invalid file diff received. Refresh to retry.')
  return { path: value.path, originalPath: value.originalPath, status: value.status, base: value.base as GitDiff['base'],
    binary: value.binary, truncated: value.truncated, hunks: value.hunks, notice: value.notice,
    ...(typeof value.sourcePath === 'string' ? { sourcePath: value.sourcePath } : {}) }
}

export function gitUnavailableLabel(reason: GitStatus['reason']): string {
  if (reason === 'remote_unsupported') return 'Git changes are not available for this remote workdir. No local folder was used.'
  if (reason === 'git_unavailable') return 'Git is not installed or is unavailable on the owning device.'
  if (reason === 'not_repository') return 'This folder is not a Git repository.'
  return 'Git status is not available for this workdir.'
}

export function createGitFilesClient(apiBase: string, sessionId: string, projectId?: string) {
  const root = projectId ? `/api/projects/${encodeURIComponent(projectId)}` : `/api/sessions/${encodeURIComponent(sessionId)}`
  async function request(operation: string, signal: AbortSignal, file?: string): Promise<unknown> {
    const url = new URL(`${root}/git/${operation}`, apiBase)
    if (file !== undefined) url.searchParams.set('path', file)
    const response = await fetch(url, { signal })
    const value: unknown = await response.json()
    if (!response.ok) throw new Error(record(value) && typeof value.message === 'string' ? value.message : `Could not load Git changes (${response.status}). Retry.`)
    return value
  }
  return {
    status: async (signal: AbortSignal) => parseGitStatus(await request('status', signal)),
    diff: async (file: string, signal: AbortSignal) => parseGitDiff(await request('diff', signal, file), file),
  }
}
