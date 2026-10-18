import { t } from './i18n.ts'
import type { FileEntry } from './composables/useSessionFiles.ts'
import { apiUrl } from './api-url.ts'
import { nodeOfflineError, workdirUnavailableMessage } from './workdir-request-error.ts'
import { parseGitStatus, parseGitDiff, type GitChangeKind, type GitChange, type GitStatus, type GitHunk } from '../../src/execution/git/contracts.ts'
export { parseGitStatus, parseGitDiff, type GitChangeKind, type GitChange, type GitStatus, type GitHunk, type GitDiff } from '../../src/execution/git/contracts.ts'

const kinds: readonly GitChangeKind[] = ['conflicted', 'modified', 'typechanged', 'deleted', 'renamed', 'added', 'untracked']
const badges: Record<GitChangeKind, string> = {
  modified: 'M', added: 'A', deleted: 'D', renamed: 'R', untracked: 'U', conflicted: '!', typechanged: 'T',
}
const labels: Record<GitChangeKind, string> = {
  get modified() { return t('Modified') }, get added() { return t('Added') }, get deleted() { return t('Deleted') }, get renamed() { return t('Renamed') },
  get untracked() { return t('Untracked') }, get conflicted() { return t('Conflicted') }, get typechanged() { return t('Type changed') },
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

export function gitUnavailableLabel(reason: GitStatus['reason']): string {
  if (reason === 'remote_unsupported') return t('Git changes are not available for this remote workdir. No local folder was used.')
  if (reason === 'git_unavailable') return t('Git is not installed or is unavailable on the owning device.')
  if (reason === 'not_repository') return t('This folder is not a Git repository.')
  return t('Git status is not available for this workdir.')
}

export function createGitFilesClient(apiBase: string, sessionId: string, folderId?: string, sessionWorkspace = false) {
  const root = folderId ? `/api/folders/${encodeURIComponent(folderId)}` : `/api/sessions/${encodeURIComponent(sessionId)}${sessionWorkspace ? "/workspace" : ""}`
  async function request(operation: string, signal: AbortSignal, file?: string): Promise<unknown> {
    const url = apiUrl(apiBase, `${root}/git/${operation}`)
    if (file !== undefined) url.searchParams.set('path', file)
    const response = await fetch(url, { signal })
    const value: unknown = response.headers.get('content-type')?.includes('application/json') ? await response.json() : null
    if (!response.ok) {
      const offline = nodeOfflineError(response.status, value)
      if (offline) throw offline
      if (response.status === 401 || response.status === 403) throw new Error(t('Access to these Git changes was denied.'))
      if (response.status === 404) throw new Error(t('This file or workdir is no longer available. Refresh files and changes.'))
      const unavailable = workdirUnavailableMessage(value)
      if (unavailable) throw new Error(unavailable)
      throw new Error(record(value) && typeof value.message === 'string' ? value.message : t('Could not load Git changes ({status}). Retry.', { status: response.status }))
    }
    return value
  }
  return {
    status: async (signal: AbortSignal) => parseGitStatus(await request('status', signal)),
    diff: async (file: string, signal: AbortSignal) => parseGitDiff(await request('diff', signal, file), file),
  }
}
