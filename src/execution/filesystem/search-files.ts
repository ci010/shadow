import { spawn } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { StringDecoder } from 'node:string_decoder'

export const FILE_SEARCH_LIMIT = 200
const MAX_RESULT_BYTES = 64 * 1024

export function validFileSearchQuery(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128 && !/[\0\r\n]/.test(value)
}

export interface FileSearchResult {
  paths: string[]
  truncated: boolean
}

export function parseFileSearchResult(value: unknown): FileSearchResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid file search result')
  const result = value as Record<string, unknown>
  if (!Array.isArray(result.paths) || result.paths.length > FILE_SEARCH_LIMIT || typeof result.truncated !== 'boolean'
    || result.paths.some(path => typeof path !== 'string' || !path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\\')
      || path.split('/').some((part: string) => part === '..' || !part) || path.includes('\0'))) {
    throw new Error('Invalid file search result')
  }
  return { paths: result.paths as string[], truncated: result.truncated }
}

/** Search relative paths using rg's ignore rules, without following symlinks or reading file contents. */
export async function searchWorkspaceFiles(root: string, query: string, signal: AbortSignal): Promise<FileSearchResult> {
  if (!validFileSearchQuery(query)) throw new TypeError('Invalid file search query')
  signal.throwIfAborted()
  const cwd = await realpath(root)
  const needle = query.trim().toLocaleLowerCase()
  return await new Promise<FileSearchResult>((resolve, reject) => {
    const proc = spawn('rg', ['--files', '--hidden', '--glob=!.git/**', '--null', '.'], {
      cwd, stdio: ['ignore', 'pipe', 'pipe'], signal,
    })
    const paths: string[] = []
    let remainder = ''
    let stderr = ''
    let truncated = false
    let bytes = 0
    let settled = false
    const decoder = new StringDecoder('utf8')
    proc.stdout.on('data', (chunk: Buffer) => {
      remainder += decoder.write(chunk)
      let end: number
      while ((end = remainder.indexOf('\0')) !== -1) {
        const path = remainder.slice(0, end).replaceAll('\\', '/').replace(/^\.\//, '')
        remainder = remainder.slice(end + 1)
        if (!path.toLocaleLowerCase().includes(needle)) continue
        if (paths.length === FILE_SEARCH_LIMIT || bytes + Buffer.byteLength(path) > MAX_RESULT_BYTES) {
          truncated = true
          proc.kill()
          return
        }
        paths.push(path)
        bytes += Buffer.byteLength(path)
      }
    })
    proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8').slice(0, 1024 - stderr.length) })
    proc.once('error', error => {
      if (settled) return
      settled = true
      reject(signal.aborted ? signal.reason : error)
    })
    proc.once('close', code => {
      if (settled) return
      settled = true
      if (signal.aborted) reject(signal.reason)
      else if (!truncated && code !== 0 && !(code === 1 && !stderr)) reject(new Error(stderr || `ripgrep exited with status ${code}`))
      else resolve({ paths: paths.sort((a, b) => a.localeCompare(b)), truncated })
    })
  })
}
