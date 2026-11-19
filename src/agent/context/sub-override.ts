import { createHash, randomUUID } from 'node:crypto'
import { constants, lstatSync, realpathSync } from 'node:fs'
import { link, mkdir, open, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const limit = 16 * 1024
const validRevision = /^[a-f0-9]{64}$/
const revisionOf = (text: string) => createHash('sha256').update(text).digest('hex')

/** Host-owned project data, never a caller-selected path or execution workspace. */
export class SubOverrideStore {
  constructor(private projectHome: string) {}

  private async directory(create: boolean): Promise<string> {
    const root = realpathSync(this.projectHome)
    const directory = resolve(root, 'sub-prompt-drafts')
    if (create) await mkdir(directory, { mode: 0o700 }).catch(error => {
      if (error.code !== 'EEXIST') throw error
    })
    if (!lstatSync(directory).isDirectory() || realpathSync(directory) !== directory) {
      throw new Error('Unsafe sub draft directory')
    }
    return directory
  }

  async read(revision: unknown): Promise<string> {
    if (typeof revision !== 'string' || !validRevision.test(revision)) throw new Error('Invalid sub draft revision')
    try {
      const directory = await this.directory(false)
      const path = join(directory, `${revision}.md`)
      const entry = lstatSync(path)
      if (!entry.isFile() || entry.nlink !== 1 || entry.size > limit) throw new Error('Unsafe sub draft file')
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > limit || stat.dev !== entry.dev || stat.ino !== entry.ino) {
          throw new Error('Unsafe sub draft file')
        }
        const bytes = Buffer.alloc(limit + 1)
        const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
        const text = bytes.subarray(0, bytesRead).toString('utf8')
        if (bytesRead !== stat.size || Buffer.byteLength(text) !== bytesRead || revisionOf(text) !== revision) {
          throw new Error('Sub draft integrity check failed')
        }
        return text
      } finally { await file.close() }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('Explicit sub draft revision was not found')
      throw error
    }
  }

  async save(markdown: string): Promise<string> {
    if (!markdown.trim() || Buffer.byteLength(markdown) > limit || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(markdown) || Buffer.from(markdown).toString('utf8') !== markdown) {
      throw new Error('Sub draft must be nonempty Markdown (at most 16 KiB) without control characters')
    }
    const revision = revisionOf(markdown)
    const directory = await this.directory(true)
    const temporary = join(directory, `.draft-${randomUUID()}`)
    const file = await open(temporary, 'wx', 0o600)
    try {
      try { await file.writeFile(markdown); await file.sync() } finally { await file.close() }
      await link(temporary, join(directory, `${revision}.md`)).catch(error => {
        if (error.code !== 'EEXIST') throw error
      })
    } finally { await unlink(temporary) }
    await this.read(revision)
    return revision
  }
}
