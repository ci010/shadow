import { spawn } from 'node:child_process'
import { isAbsolute, relative } from 'node:path'

export interface FilesystemSearch {
  handler: 'grep' | 'glob'
  query: string
  include?: string
  limit?: number
  offset?: number
}

export function parseFilesystemSearch(value: unknown): FilesystemSearch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid filesystem search')
  const args = value as Record<string, unknown>
  if (Object.keys(args).some(key => !['handler', 'query', 'include', 'limit', 'offset'].includes(key)) ||
    !['grep', 'glob'].includes(String(args.handler)) || typeof args.query !== 'string' || args.query.includes('\0') ||
    (args.include !== undefined && (args.handler !== 'grep' || typeof args.include !== 'string' || !args.include || isAbsolute(args.include) || args.include.includes('\0'))) ||
    (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 100)) ||
    (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0))) throw new TypeError('Invalid filesystem search')
  return args as unknown as FilesystemSearch
}

/** Runs only on the owning device, without shell expansion, installation or symlink traversal.
 * Bound raw output as well as the returned page; refuse oversized searches rather than silently dropping hits.
 */
export async function searchFilesystem(target: string, search: FilesystemSearch, signal: AbortSignal, root: string): Promise<string> {
  signal.throwIfAborted()
  const args = ['--no-config', '--hidden']
  if (search.handler === 'glob') args.push('--files', '--null', `--glob=${search.query}`)
  else {
    args.push('--json')
    if (search.include) args.push(`--glob=${search.include}`)
    args.push('-e', search.query)
  }
  args.push('--glob=!**/.git/**', '--glob=!.DS_Store')
  if (process.platform === 'win32') {
    for (const name of ['nul', 'con', 'prn', 'aux', 'com[1-9¹²³]', 'lpt[1-9¹²³]', 'conin$', 'conout$']) args.push(`--iglob=!${name}`, `--iglob=!${name}.*`)
  }
  args.push('--', target)
  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'], signal })
    const chunks: Buffer[] = []
    let bytes = 0
    let stderr = ''
    let oversized = false
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length
      if (bytes > 4 * 1024 * 1024) { oversized = true; child.kill(); return }
      chunks.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, Math.max(0, 2048 - stderr.length)) })
    child.once('error', reject)
    child.once('close', code => {
      if (signal.aborted) reject(signal.reason)
      else if (oversized) reject(new Error('Search exceeded the 4 MiB scan output limit; narrow path, query or include.'))
      else if (code !== 0 && code !== 1) reject(new Error(`ripgrep search failed: ${stderr || code}`))
      else resolve(Buffer.concat(chunks).toString('utf8'))
    })
  })
  const matches: string[] = []
  if (search.handler === 'glob') matches.push(...stdout.split('\0').filter(Boolean).map(path => relative(root, path)).sort())
  else for (const line of stdout.split('\n').filter(Boolean)) {
    const event = JSON.parse(line)
    if (event.type !== 'match') continue
    if (typeof event.data.path.text !== 'string' || typeof event.data.lines.text !== 'string') throw new Error('Search encountered non-UTF-8 paths or content')
    const text = event.data.lines.text.replace(/\r?\n$/, '')
    matches.push(`${relative(root, event.data.path.text)}:  Line ${event.data.line_number}: ${text.slice(0, 2000)}${text.length > 2000 ? '...' : ''}`)
  }
  if (!matches.length) return search.handler === 'glob' ? 'No files found' : 'No matches found'
  const offset = search.offset ?? 0
  const end = Math.min(matches.length, offset + (search.limit ?? 100))
  return `Found ${matches.length} ${search.handler === 'glob' ? 'files' : 'matches'}\n${matches.slice(offset, end).join('\n')}${end < matches.length ? `\n[truncated: use offset=${end} to read more]` : ''}`
}
