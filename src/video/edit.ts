import { open, realpath, lstat, unlink, link } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { revisionOf } from './index.ts'
import { assertLocalPath } from './media-profile.ts'
import { MAX_OTIO_BYTES } from '../shared/otio-model.ts'
import { prepareOtioProfile } from '../shared/otio-effects.ts'

const MAX_PATCH_BYTES = 1024 * 1024
const MAX_OPERATIONS = 256
const forbidden = new Set(['__proto__', 'prototype', 'constructor'])
type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
function object(v: unknown): v is Record<string, Json> { return v !== null && typeof v === 'object' && !Array.isArray(v) }
function checkJson(v: Json, depth = 0, budget = { count: 0 }): void {
  if (++budget.count > 200000 || depth > 64) throw new Error('JSON structure limit exceeded')
  if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('Invalid JSON number')
  if (v && typeof v === 'object') for (const k of Object.keys(v)) {
    if (forbidden.has(k)) throw new Error('Forbidden prototype key')
    checkJson((v as Record<string, Json>)[k]!, depth + 1, budget)
  }
}
async function boundedRead(file: string, limit: number, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const h = await open(file, 'r')
  try {
    if (!(await h.stat()).isFile()) throw new Error('Expected regular file')
    const chunks: Buffer[] = []; let size = 0
    for (;;) {
      signal?.throwIfAborted()
      const chunk = Buffer.alloc(Math.min(65536, limit + 1 - size))
      const { bytesRead } = await h.read(chunk)
      if (!bytesRead) break
      size += bytesRead
      if (size > limit) throw new Error('File exceeds size limit')
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
  } finally { await h.close() }
}
function tokens(pointer: Json | undefined): string[] {
  if (typeof pointer !== 'string' || !pointer.startsWith('/') || pointer.length > 8192) throw new Error('Invalid JSON pointer; root edits are forbidden')
  return pointer.slice(1).split('/').map(k => {
    if (/~(?:[^01]|$)/.test(k)) throw new Error('Invalid JSON pointer escape')
    const key = k.replace(/~1/g, '/').replace(/~0/g, '~')
    if (forbidden.has(key)) throw new Error('Forbidden prototype key')
    return key
  })
}
function index(key: string, length: number, add = false) {
  if (add && key === '-') return length
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error('Invalid array index')
  const n = Number(key)
  if (!Number.isSafeInteger(n) || n > length || (!add && n === length)) throw new Error('Array index out of bounds')
  return n
}
function child(parent: Json, key: string): Json {
  if (Array.isArray(parent)) return parent[index(key, parent.length)]!
  if (!object(parent) || !Object.hasOwn(parent, key)) throw new Error('Missing own property')
  return parent[key]!
}
function apply(root: Json, op: Json) {
  if (!object(op)) throw new Error('Invalid patch operation')
  const kind = op.op
  if (kind === 'move' || kind === 'copy') throw new Error(`Unsupported patch operation: ${kind}`)
  if (!['add', 'remove', 'replace', 'test'].includes(String(kind))) throw new Error('Unsupported patch operation')
  const fields = kind === 'remove' ? ['op', 'path'] : ['op', 'path', 'value']
  if (Object.keys(op).length !== fields.length || fields.some(k => !Object.hasOwn(op, k))) throw new Error('Invalid operation fields')
  const keys = tokens(op.path), key = keys.pop()!
  let parent = root
  for (const k of keys) parent = child(parent, k)
  if (kind === 'test') {
    if (!isDeepStrictEqual(child(parent, key), op.value)) throw new Error('Patch test failed')
    return
  }
  if (Array.isArray(parent)) {
    const n = index(key, parent.length, kind === 'add')
    parent.splice(n, kind === 'add' ? 0 : 1, ...(kind === 'remove' ? [] : [structuredClone(op.value!)]))
  } else {
    if (!object(parent)) throw new Error('Expected patch object parent')
    if (key in parent && !Object.hasOwn(parent, key)) throw new Error('Inherited properties are forbidden')
    if (kind !== 'add' && !Object.hasOwn(parent, key)) throw new Error('Missing own property')
    if (kind === 'remove') delete parent[key]
    else parent[key] = structuredClone(op.value!)
  }
}

/** No media IO. Optimistic source recheck, not a cross-process compare-and-swap.
 * Canonical parents reduce aliasing; portable fs APIs cannot pin parent directory
 * resolution against hostile renames. Temp cleanup checks identity but also has
 * a check/unlink race. Use a trusted directory, not an adversarial shared one.
 * A synced private temp is hard-linked atomically with no clobber. Cancellation
 * is checked immediately before publication; once link succeeds the edit is
 * committed, even if cancellation arrives while link is in flight. No rollback
 * removes a published target. Directory-entry crash durability is not promised.
 */
export async function editTimeline(file: string, patchFile: string, output: string, options: { revision: string; signal?: AbortSignal }) {
  for (const p of [file, patchFile, output]) {
    assertLocalPath(p)
    if (/^[a-z][a-z\d+.-]*:/i.test(p) && !/^[a-z]:[\\/]/i.test(p)) throw new Error('Expected local filesystem path')
  }
  options.signal?.throwIfAborted()
  if (path.extname(output).toLowerCase() !== '.otio') throw new Error('Output must use .otio')
  const source = await realpath(file), patchPath = await realpath(patchFile)
  const parent = await realpath(path.dirname(path.resolve(output)))
  if (parent !== path.dirname(source)) throw new Error('Output must have the same actual parent directory as source')
  const target = path.join(parent, path.basename(output))
  if (target === source || target === patchPath) throw new Error('Output cannot overwrite source or patch')
  const text = await boundedRead(source, MAX_OTIO_BYTES, options.signal), sourceRevision = revisionOf(text)
  if (sourceRevision !== options.revision) throw new Error('Revision mismatch; run plan again')
  const raw: Json = JSON.parse(text), patch: Json = JSON.parse(await boundedRead(patchPath, MAX_PATCH_BYTES, options.signal))
  checkJson(raw); checkJson(patch)
  if (!Array.isArray(patch) || patch.length > MAX_OPERATIONS) throw new Error('Patch must be an array of at most 256 operations')
  for (const op of patch) {
    options.signal?.throwIfAborted(); apply(raw, op); checkJson(raw)
    if (Buffer.byteLength(JSON.stringify(raw)) > MAX_OTIO_BYTES) throw new Error('Result exceeds size limit')
  }
  const result = JSON.stringify(raw) + '\n'
  if (Buffer.byteLength(result) > MAX_OTIO_BYTES) throw new Error('Result exceeds size limit')
  const profile = prepareOtioProfile(result), { model } = profile
  if (profile.diagnostics.length || !(model.duration > 0) || model.duration > 86400 || model.rate < 1 || model.rate > 120) throw new Error('Unsupported timeline duration/rate or diagnostics')
  options.signal?.throwIfAborted()
  const temp = path.join(parent, `.shadow-edit-${randomUUID()}.tmp`)
  const h = await open(temp, 'wx', 0o600)
  let identity: Awaited<ReturnType<typeof h.stat>> | undefined
  try {
    identity = await h.stat()
    await h.writeFile(result, { encoding: 'utf8', signal: options.signal })
    await h.sync()
    await h.close()
    if (revisionOf(await boundedRead(source, MAX_OTIO_BYTES, options.signal)) !== sourceRevision) throw new Error('Source changed during editing')
    if (await realpath(path.dirname(path.resolve(output))) !== parent || await realpath(file) !== source) throw new Error('Path changed during editing')
    options.signal?.throwIfAborted()
    await link(temp, target)
    // Publication is the commit point: do not report a late abort or remove target.
  } finally {
    await h.close().catch(() => {})
    const current = await lstat(temp).catch(() => undefined)
    if (identity && current && current.dev === identity.dev && current.ino === identity.ino) await unlink(temp)
  }
  return { file: target, sourceRevision, revision: revisionOf(result), operations: patch.length, duration: model.duration, rate: model.rate }
}
