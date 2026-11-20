import { AsyncLocalStorage } from 'node:async_hooks'
import type { InboundMessage } from '../bus/events.ts'
import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { imageFromBytes } from '../utils/image-input.ts'
import {
  captureExceedsLimits, captureId, captureRecord, captureVector, GLTF_CAPTURE_HEADER, GLTF_CAPTURE_PATH, parseCaptureView,
  GLTF_CAPTURE_LIMIT_ERROR, GLTF_CAPTURE_MAX_IMAGE, GLTF_CAPTURE_MAX_IDS, GLTF_CAPTURE_MAX_ID_BYTES,
  type GltfCaptureResult, type GltfCaptureScope, type GltfCaptureView,
} from '../gltf-capture-contract.ts'

type Owner = object | AbortSignal
export type GltfCaptureOwner = (request: Request) => Owner | undefined | Promise<Owner | undefined>
type Job = { id: string; messageId: string; version: string; view: GltfCaptureView; deadline: number; delivered: boolean; finish(result?: GltfCaptureResult, error?: string): void }
type Binding = { id: string; scope: GltfCaptureScope; owner: Owner; established: boolean; expires: number; wake?: () => void; job?: Job; detach(): void }
const POLL = 12_000
const LEASE = 20_000
const CAPTURE = 8_000
// All max-length IDs fit even if JSON must escape every quote/backslash.
const RESULT_LIMIT = GLTF_CAPTURE_MAX_IMAGE + GLTF_CAPTURE_MAX_IDS * (GLTF_CAPTURE_MAX_ID_BYTES * 2 + 3) + 16 * 1024
const token = (value: string | null | undefined) => /^[\da-f-]{36}$/.test(value ?? '')

function parseResult(input: unknown): GltfCaptureResult | undefined {
  const r = captureRecord(input), camera = captureRecord(r?.camera)
  if (!r || (r.mimeType !== 'image/png' && r.mimeType !== 'image/jpeg') || typeof r.data !== 'string' ||
    !r.data.length || captureExceedsLimits(r) || !Array.isArray(r.objectIds) ||
    !r.objectIds.every(captureId) || !camera ||
    !captureVector(camera.position) || !captureVector(camera.target)) return
  const bytes = Buffer.from(r.data, 'base64')
  if (bytes.toString('base64') !== r.data) return
  const format = r.mimeType === 'image/png' ? 'png' : 'jpeg'
  if (format === 'png' ? !bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
      !bytes.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex')) :
    bytes[0] !== 255 || bytes[1] !== 216 || bytes.at(-2) !== 255 || bytes.at(-1) !== 217) return
  try {
    const { width, height } = imageFromBytes(bytes, r.mimeType)
    if (width * height > 16_777_216) return
  } catch { return }
  return { mimeType: r.mimeType, data: r.data, camera: { position: camera.position, target: camera.target }, objectIds: r.objectIds }
}

/** Private request/reply transport. The general realtime feed is subscribable by any
 * authenticated client and has no per-tab ownership; never publish captures there. */
export class GltfCaptureBridge {
  private readonly admission = new AsyncLocalStorage<Request>()
  private readonly bindings = new Map<string, Binding>()
  private readonly turns = new Map<string, { binding: Binding; expires: number }>()
  private readonly timer = setInterval(() => this.prune(), 1000).unref()
  private closed = false

  constructor(private readonly projectId: string, private readonly owner: GltfCaptureOwner,
    private readonly sessionAllowed: (sessionId: string) => boolean, private readonly sessionExists = sessionAllowed) {}

  private drop(b: Binding) {
    if (!this.bindings.delete(b.id)) return
    b.detach()
    b.wake?.()
    b.job?.finish()
    for (const [id, turn] of this.turns) if (turn.binding === b) this.turns.delete(id)
  }

  private prune() {
    const now = Date.now()
    for (const b of this.bindings.values()) if (b.expires <= now || !(b.established ? this.sessionExists(b.scope.sessionId) : this.sessionAllowed(b.scope.sessionId))) this.drop(b)
    for (const [id, turn] of this.turns) if (turn.expires <= now) this.finishTurn(id)
  }

  private unique(sessionId: string): Binding | undefined {
    const matches = [...this.bindings.values()].filter(b => b.scope.sessionId === sessionId)
    return matches.length === 1 ? matches[0] : undefined
  }

  close() {
    this.closed = true
    clearInterval(this.timer)
    for (const b of this.bindings.values()) this.drop(b)
    this.turns.clear()
  }

  /** Called by Web admission, before routing the new direct user input. Neither the
   * browser binding nor its credential is put into persisted chat/inference data. */
  async admitWebInput(message: InboundMessage): Promise<void> {
    const request = this.admission.getStore()
    if (!request || message.channel !== 'web' || message.senderId !== 'web-user' || !message.admin || message.isGroup || message.retry || message.silent) return
    const sessionId = `web:${message.chatId}`
    const id = request.headers.get(GLTF_CAPTURE_HEADER)
    if (!token(id)) return
    const owner = await this.owner(request)
    if (!owner || request.signal.aborted) return
    this.prune()
    const b = this.unique(sessionId)
    if (b?.id === id && b.owner === owner && this.sessionExists(sessionId) && this.turns.size < 512) {
      b.established = true
      this.turns.set(message.messageId, { binding: b, expires: Date.now() + 10 * 60_000 })
    }
  }

  finishTurn(messageId: string) {
    const binding = this.turns.get(messageId)?.binding
    this.turns.delete(messageId)
    if (binding?.job?.messageId === messageId) binding.job.finish()
  }

  available(sessionId: string, messageId: string): boolean {
    this.prune()
    const binding = this.turns.get(messageId)?.binding
    return !!binding && binding.scope.sessionId === sessionId && this.unique(sessionId) === binding && this.sessionExists(sessionId)
  }

  async capture(scope: Omit<GltfCaptureScope, 'version'> & { version?: string; afterVersion?: string }, messageId: string, view: GltfCaptureView, signal: AbortSignal): Promise<GltfCaptureResult & { version: string }> {
    signal.throwIfAborted()
    this.prune()
    const b = this.turns.get(messageId)?.binding
    if (!b || b.scope.projectId !== scope.projectId || b.scope.sessionId !== scope.sessionId ||
      b.scope.assetId !== scope.assetId || this.unique(scope.sessionId) !== b ||
      !this.sessionExists(scope.sessionId) || b.job) throw new Error('No unique, live Viewer binding for this turn, session and asset.')
    if (scope.version !== undefined && b.scope.version !== scope.version) throw new Error('The active Viewer version does not match the requested version. Verify reload and retry; no image was captured.')
    if (b.scope.version === scope.afterVersion) throw new Error('The Viewer still has the previous asset version. Wait for the new render to load, then retry with afterVersion; no image was captured.')
    return await new Promise((resolve, reject) => {
      const finish = (result?: GltfCaptureResult, error?: string) => {
        if (b.job !== job) return
        b.job = undefined
        clearTimeout(timeout)
        signal.removeEventListener('abort', cancel)
        if (result && !signal.aborted && Date.now() < job.deadline && this.unique(scope.sessionId) === b) resolve({ ...result, version: job.version })
        else reject(new Error(error ?? 'Viewer capture failed, expired, or was cancelled.'))
      }
      const cancel = () => finish()
      const timeout = setTimeout(cancel, CAPTURE)
      const job: Job = { id: randomUUID(), messageId, version: b.scope.version, view, deadline: Date.now() + CAPTURE, delivered: false, finish }
      b.job = job
      signal.addEventListener('abort', cancel, { once: true })
      b.wake?.()
    })
  }

  mount(app: Hono) {
    app.use('/api/chat/send', (c, next) => c.req.method === 'POST' && c.req.header(GLTF_CAPTURE_HEADER)
      ? this.admission.run(c.req.raw, next) : next())
    // bodyLimit may replace c.req.raw while bounding a chunked body. Preserve
    // the original request's in-process gateway/device proof across that clone.
    const sourceRequests = new WeakMap<object, Request>()
    app.use(`${GLTF_CAPTURE_PATH}/*`, async (c, next) => {
      sourceRequests.set(c, c.req.raw)
      c.header('Cache-Control', 'no-store')
      await next()
    })
    app.post(`${GLTF_CAPTURE_PATH}/register`, bodyLimit({ maxSize: 24 * 1024 }), async c => {
      const owner = await this.owner(sourceRequests.get(c)!)
      if (!owner || this.closed || c.req.raw.signal.aborted) return c.body(null, 403)
      const input = captureRecord(await c.req.json().catch(() => undefined))
      if (!input || input.projectId !== this.projectId || !captureId(input.sessionId) || !captureId(input.assetId) || !captureId(input.version)) return c.body(null, 400)
      this.prune()
      if (!this.sessionAllowed(input.sessionId) || this.bindings.size >= 64 || c.req.raw.signal.aborted || this.closed || (owner instanceof AbortSignal && owner.aborted)) return c.body(null, 409)
      const scope = { projectId: this.projectId, sessionId: input.sessionId, assetId: input.assetId, version: input.version }
      const id = randomUUID()
      const revoke = () => this.drop(b)
      const b: Binding = { id, scope, owner, established: this.sessionExists(scope.sessionId), expires: Date.now() + LEASE, detach: () => {
        if (owner instanceof AbortSignal) owner.removeEventListener('abort', revoke)
      } }
      // A new candidate invalidates older turns immediately, even if it is later removed.
      for (const existing of this.bindings.values()) if (existing.scope.sessionId === scope.sessionId) existing.job?.finish()
      for (const [key, turn] of this.turns) if (turn.binding.scope.sessionId === scope.sessionId) this.turns.delete(key)
      this.bindings.set(id, b)
      if (owner instanceof AbortSignal) owner.addEventListener('abort', revoke, { once: true })
      return c.json({ binding: id })
    })

    const binding = async (request: Request) => {
      const id = request.headers.get(GLTF_CAPTURE_HEADER)
      if (!token(id)) return
      const owner = await this.owner(request)
      this.prune()
      const b = this.bindings.get(id!)
      if (owner && b?.owner === owner && !request.signal.aborted) return b
    }
    app.post(`${GLTF_CAPTURE_PATH}/poll`, async c => {
      const b = await binding(sourceRequests.get(c)!)
      if (!b || b.wake) return c.body(null, 409)
      const signal = c.req.raw.signal
      b.expires = Date.now() + LEASE
      if (!b.job || b.job.delivered) await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(timeout)
          signal.removeEventListener('abort', finish)
          b.wake = undefined
          resolve()
        }
        const timeout = setTimeout(finish, POLL)
        b.wake = finish
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
      if (signal.aborted) { this.drop(b); return c.body(null, 409) }
      if (await binding(sourceRequests.get(c)!) !== b) return c.body(null, 409)
      const job = b.job
      if (!job || job.delivered || Date.now() >= job.deadline || this.unique(b.scope.sessionId) !== b) return c.body(null, 204)
      job.delivered = true
      return c.json({ id: job.id, scope: b.scope, view: job.view, budgetMs: job.deadline - Date.now() })
    })
    app.post(`${GLTF_CAPTURE_PATH}/version`, bodyLimit({ maxSize: 24 * 1024 }), async c => {
      const b = await binding(sourceRequests.get(c)!)
      if (!b) return c.body(null, 409)
      const body = captureRecord(await c.req.json().catch(() => undefined))
      if (!body || !captureId(body.version)) return c.body(null, 400)
      if (await binding(sourceRequests.get(c)!) !== b || body.previousVersion !== b.scope.version) return c.body(null, 409)
      if (body.version !== b.scope.version) {
        b.job?.finish()
        b.scope.version = body.version
      }
      return c.body(null, 204)
    })
    app.post(`${GLTF_CAPTURE_PATH}/result`, bodyLimit({ maxSize: RESULT_LIMIT }), async c => {
      const b = await binding(sourceRequests.get(c)!)
      const job = b?.job
      if (!b || !job?.delivered) return c.body(null, 409)
      const body = captureRecord(await c.req.json().catch(() => undefined))
      if (body?.id !== job.id || await binding(sourceRequests.get(c)!) !== b || b.job !== job ||
        Date.now() >= job.deadline || job.version !== b.scope.version || this.unique(b.scope.sessionId) !== b || !this.sessionExists(b.scope.sessionId)) return c.body(null, 409)
      const rawResult = captureRecord(body.result)
      if ((body.result === null && body.error === 'limits') || (rawResult && captureExceedsLimits(rawResult))) {
        job.finish(undefined, GLTF_CAPTURE_LIMIT_ERROR)
        return c.body(null, 204)
      }
      const result = parseResult(body.result)
      job.finish(result)
      return c.body(null, result || body.result === null ? 204 : 400)
    })
    app.post(`${GLTF_CAPTURE_PATH}/unregister`, async c => {
      const b = await binding(sourceRequests.get(c)!)
      if (b) this.drop(b)
      return c.body(null, 204)
    })
  }
}
