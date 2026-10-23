import type { Context } from 'hono'
import { parseFileSearchResult, searchWorkspaceFiles, validFileSearchQuery } from '../execution/filesystem/search-files.ts'

export function fileSearchQuery(c: Context): string | null {
  const query = c.req.query('query')
  return validFileSearchQuery(query) ? query : null
}

export async function serveLocalFileSearch(c: Context, base: string): Promise<Response> {
  const query = fileSearchQuery(c)
  if (!query) return c.json({ error: 'invalid_query', message: 'Enter a file path search of at most 128 characters.' }, 400)
  try {
    return c.json(await searchWorkspaceFiles(base, query, c.req.raw.signal))
  } catch (error) {
    if (c.req.raw.signal.aborted) return c.json({ error: 'request_cancelled' }, 409)
    return c.json({ error: 'file_search_failed', message: error instanceof Error && 'code' in error && error.code === 'ENOENT'
      ? 'ripgrep (rg) is not installed on this device.' : 'File search failed. Check ripgrep and retry.' }, 503)
  }
}

export function remoteFileSearchResult(output: string) {
  return parseFileSearchResult(JSON.parse(output) as unknown)
}
