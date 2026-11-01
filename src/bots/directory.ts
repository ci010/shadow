import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/** Snapshot data only. Source modules are never imported or evaluated during publication. */
export function snapshotBotDirectory(directory: string): Record<string, string> {
  const files: Record<string, string> = Object.create(null)
  let bytes = 0, entries = 0
  const walk = (relative: string,depth=0) => {
    if(depth>32 || ++entries>512)throw new Error('BOT source directory limits exceeded.')
    const path = join(directory, relative)
    const stat = lstatSync(path)
    if (stat.isSymbolicLink()) throw new Error('BOT source symlinks are forbidden.')
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) {
        // Source control is not deployment content. Never operate on the source repository.
        if (name === '.git') continue
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || name === '.' || name === '..') throw new Error('Unsafe BOT source path.')
        walk(relative ? `${relative}/${name}` : name,depth+1)
      }
      return
    }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('BOT source must contain regular, unlinked files.')
    if (Object.keys(files).length >= 240 || stat.size > 512_000 || (bytes += stat.size) > 2 * 1024 * 1024) throw new Error('BOT source exceeds snapshot limits.')
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const opened = fstatSync(fd)
      if (!opened.isFile() || opened.nlink !== 1 || opened.ino !== stat.ino || opened.dev !== stat.dev || opened.size !== stat.size) throw new Error('BOT source changed during snapshot. Retry.')
      const buffer = Buffer.alloc(stat.size + 1)
      let length = 0
      while (length < buffer.length) {
        const count = readSync(fd, buffer, length, buffer.length - length, null)
        if (!count) break
        length += count
      }
      if (length !== stat.size) throw new Error('BOT source changed during snapshot. Retry.')
      files[relative] = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length))
    } finally { closeSync(fd) }
  }
  walk('')
  return files
}

/** An actual read-only Git command, not the presence of a .git name. No checkout/index mutation. */
export function sourceUsesGit(directory: string): boolean {
  try {
    return execFileSync('git', ['--no-optional-locks', '-C', directory, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8', timeout: 5000, windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' }, stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === 'true'
  } catch { return false }
}
