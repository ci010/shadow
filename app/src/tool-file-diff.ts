import { t } from './i18n.ts'
import { fileChangesPageSchema, parseFilePatch, type RecordedFileChange, type FileChangeHunk } from '../../src/sessions/file-change-contract.ts'
import { apiUrl } from './api-url.ts'
import { diffLines, type GitHunk } from './git-files.ts'
import { highlightFile, type FileHighlightToken } from './file-highlighting.ts'
import { splitHighlightLines } from './git-diff-selection.ts'

export type ToolFileChange = RecordedFileChange & { hunks: FileChangeHunk[] }

export async function loadToolFileChanges(
  apiBase: string, sessionId: string, toolCallId: string, signal: AbortSignal, request: typeof fetch = fetch,
): Promise<ToolFileChange[]> {
  const changes: RecordedFileChange[] = []
  let total: number | undefined
  do {
    signal.throwIfAborted()
    const url = apiUrl(apiBase, `/api/sessions/${encodeURIComponent(sessionId)}/file-changes`)
    url.searchParams.set('toolCallId', toolCallId)
    url.searchParams.set('offset', String(changes.length))
    url.searchParams.set('limit', '30')
    const response = await request(url, { signal, cache: 'no-store' })
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? t('Access to this file diff was denied.')
      : response.status === 404 ? t('This session is no longer available.') : t('Could not load the recorded file diff ({status}). Retry.', { status: response.status }))
    const parsed = fileChangesPageSchema.safeParse(await response.json())
    signal.throwIfAborted()
    if (!parsed.success) throw new Error(t('Invalid recorded file diff response. Retry.'))
    const page = parsed.data
    if (page.offset !== changes.length || (total !== undefined && page.total !== total)
      || page.changes.length !== Math.min(30, Math.max(0, page.total - page.offset))
      || page.changes.some(change => change.sessionId !== sessionId || change.toolCallId !== toolCallId)
      || new Set([...changes, ...page.changes].map(change => change.id)).size !== changes.length + page.changes.length) {
      throw new Error(t('Invalid recorded file diff response. Retry.'))
    }
    changes.push(...page.changes)
    total = page.total
  } while (changes.length < total)
  return changes.map(change => ({ ...change, hunks: parseFilePatch(change.patch) }))
}

/** Tokenize each side separately so deleted code cannot change the new code's grammar state. */
export async function highlightDiffHunks(hunks: readonly GitHunk[], path: string): Promise<FileHighlightToken[][][]> {
  return Promise.all(hunks.map(async hunk => {
    const rows = diffLines(hunk)
    const [before, after] = await Promise.all([
      highlightFile(rows.filter(row => row.oldLine !== undefined).map(row => row.text).join('\n'), path).then(splitHighlightLines),
      highlightFile(rows.filter(row => row.newLine !== undefined).map(row => row.text).join('\n'), path).then(splitHighlightLines),
    ])
    let oldIndex = 0
    let newIndex = 0
    return rows.map(row => {
      const oldTokens = row.oldLine === undefined ? undefined : before[oldIndex++]
      const newTokens = row.newLine === undefined ? undefined : after[newIndex++]
      return newTokens ?? oldTokens ?? [{ text: row.text }]
    })
  }))
}
