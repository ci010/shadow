import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync,
  rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'

function insist(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function plainJson(value: unknown, depth = 0, seen = new Set<object>()): void {
  insist(depth <= 64, 'JSON nesting exceeds limit')
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return
  if (typeof value === 'number') {
    insist(Number.isFinite(value), 'JSON numbers must be finite')
    return
  }
  insist(typeof value === 'object' && value !== null, 'Expected plain JSON data')
  insist(!seen.has(value), 'Circular JSON data')
  insist(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null, 'Expected plain JSON objects')
  seen.add(value)
  insist(Reflect.ownKeys(value).every(key => typeof key === 'string'), 'JSON symbol keys are unsupported')
  if (Array.isArray(value)) {
    insist(Object.keys(value).length === value.length &&
      Object.keys(value).every((key, index) => key === String(index)), 'Expected a dense JSON array')
  }
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (Array.isArray(value) && key === 'length') continue
    insist(key !== '__proto__', 'Unsafe JSON property: __proto__')
    insist('value' in descriptor && descriptor.enumerable, 'JSON accessors are unsupported')
    plainJson(descriptor.value, depth + 1, seen)
  }
  seen.delete(value)
}

function hash(text: string | undefined): string | undefined {
  return text === undefined ? undefined : createHash('sha256').update(text).digest('hex')
}

export function assertPrivateFileBoundary(file: string): void {
  let path = resolve(file)
  const target = path
  while (true) {
    try {
      const info = lstatSync(path)
      insist(!info.isSymbolicLink(), 'Symlink private storage boundary is forbidden')
      insist(path === target ? info.isFile() && info.nlink === 1 : info.isDirectory(), 'Invalid private storage boundary')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const parent = dirname(path)
    if (parent === path) break
    path = parent
  }
}

/** A project-bound JSON document with detached reads and save-before-update disk CAS. */
export class PrivateDocument<T> {
  private readonly directory: string
  private readonly file: string
  private readonly projectId: string
  private readonly parse: (value: unknown) => T
  private readonly maxBytes: number
  private value: T
  private diskHash: string | undefined

  constructor(options: {
    projectId: string
    directory: string
    filename: string
    parse: (value: unknown) => T
    initial: T
    maxBytes?: number
  }) {
    insist(typeof options.projectId === 'string' && options.projectId.length <= 512 &&
      options.projectId.trim() === options.projectId && options.projectId.length > 0 &&
      !/[\x00-\x1f\x7f]/.test(options.projectId), 'Invalid project ID')
    insist(/^[a-z][a-z0-9-]*\.json$/.test(options.filename), 'Invalid private document filename')
    this.projectId = options.projectId
    this.parse = options.parse
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    insist(Number.isSafeInteger(this.maxBytes) && this.maxBytes > 0, 'Invalid document size limit')
    this.directory = resolve(options.directory)
    this.file = join(this.directory, options.filename)
    const text = this.readDisk()
    if (text === undefined) {
      this.value = this.checked(options.initial)
    } else {
      const raw: unknown = JSON.parse(text)
      plainJson(raw)
      insist(raw !== null && typeof raw === 'object' && !Array.isArray(raw), 'Invalid private document')
      const envelope = raw as Record<string, unknown>
      insist(Object.keys(envelope).length === 3 && envelope.version === 1 &&
        Object.hasOwn(envelope, 'value'), 'Invalid private document envelope')
      insist(envelope.projectId === this.projectId, 'Private document belongs to another project')
      this.value = this.checked(envelope.value)
    }
    this.diskHash = hash(text)
  }

  read(): T { return structuredClone(this.value) }

  assertCurrent(): void {
    insist(hash(this.readDisk()) === this.diskHash, 'Private document changed externally; reopen the store')
  }

  write(value: T): void {
    const next = this.checked(value)
    const text = JSON.stringify({ version: 1, projectId: this.projectId, value: next }) + '\n'
    insist(Buffer.byteLength(text) <= this.maxBytes, 'Private document exceeds size limit')
    this.checkBoundary(this.file)
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    this.checkBoundary(this.file)
    const lock = `${this.file}.lock`
    this.checkBoundary(lock)
    const lockFd = openSync(lock, 'wx', 0o600)
    const staging = `${this.file}.${randomUUID()}.new`
    let staged = false
    try {
      this.assertCurrent()
      const fd = openSync(staging, 'wx', 0o600)
      staged = true
      try {
        writeFileSync(fd, text, 'utf8')
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      this.checkBoundary(staging)
      this.assertCurrent()
      renameSync(staging, this.file)
      staged = false
      this.diskHash = hash(text)
      this.value = next
    } finally {
      closeSync(lockFd)
      if (staged) rmSync(staging, { force: true })
      rmSync(lock)
    }
  }

  private checked(value: unknown): T {
    plainJson(value)
    insist(Buffer.byteLength(JSON.stringify(value)) <= this.maxBytes, 'Private document exceeds size limit')
    const parsed = this.parse(structuredClone(value))
    plainJson(parsed)
    return structuredClone(parsed)
  }

  private checkBoundary(file: string): void {
    assertPrivateFileBoundary(file)
  }

  private readDisk(): string | undefined {
    this.checkBoundary(this.file)
    try {
      insist(lstatSync(this.file).size <= this.maxBytes, 'Private document exceeds size limit')
      return readFileSync(this.file, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}
