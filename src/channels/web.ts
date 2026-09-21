import { AbstractChannel, ChannelAdmissionError } from './base.ts'
import type { ChannelCapabilities } from './capabilities.ts'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { Hono } from 'hono'
import { saveToUploads, sessionWorkspacePath } from '../utils/paths.ts'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveSessionLocations } from '../sessions/locality.ts'
import { FolderError } from '../folders/registry.ts'
import { isConfigObject, parseSessionConfigPatch, type SessionConfigPatch } from '../sessions/config-patch.ts'
import type { RealtimePublisher } from '../realtime/hub.ts'
import type { RealtimeTurnFinishedPayload } from '../realtime/protocol.ts'
import { isCommandReceipt } from '../slash-commands/receipt.ts'
import { isMissingMediaFile, mediaFileResponse } from './media-response.ts'

function outboundPayload(msg: OutboundMessage) {
  if (msg.sessionMessage) return { event: 'session_message', message: msg.sessionMessage, media: msg.media }
  const receipt = msg.metadata?.commandReceipt
  if (receipt !== undefined) {
    if (!isCommandReceipt(receipt)) throw new TypeError('Invalid outbound command receipt')
    return { event: 'command_result', done: true, receipt }
  }
  return {
    event: msg.event ?? 'response', content: msg.content, done: msg.done ?? false,
    media: msg.media, usage: msg.usage, toolCall: msg.toolCall,
    toolCallId: msg.toolCallId, toolName: msg.toolName,
  }
}

function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') ||
    isAbsolute(rel)
}

export async function resolveSessionMediaPath(
  sessionRoot: string,
  mediaPath: string,
): Promise<string | null> {
  if (!mediaPath || mediaPath.includes('\0') || isAbsolute(mediaPath)) return null

  const target = resolve(sessionRoot, mediaPath)
  if (target === sessionRoot || escapesRoot(sessionRoot, target)) return null

  try {
    const [realRoot, realTarget] = await Promise.all([
      realpath(sessionRoot),
      realpath(target),
    ])
    return realTarget !== realRoot && !escapesRoot(realRoot, realTarget)
      ? realTarget
      : null
  } catch (error) {
    if (isMissingMediaFile(error)) return null
    throw error
  }
}

/**
 * Web channel — HTTP commands with responses published through shared realtime.
 *
 * Endpoints:
 *  POST /api/chat/send     — admit a message and return its request ID
 *  POST /api/chat/message  — send message, wait for full response (sync REST)
 *  POST /api/chat/upload   — upload file/image, returns absolute private-session path
 *  GET  /api/chat/uploads/* — serve uploaded / outbound media files
 *  GET/HEAD /api/media — chatId for web workdir media, or an existing sessionId
 *    for private uploads only; path supports uploads/... and absolute upload refs.
 *    Both file routes support byte ranges and download=1.
 */
export class WebChannel extends AbstractChannel {
  readonly name = 'web'

  override getCapabilities(): ChannelCapabilities {
    return {
      conversation: 'web', format: 'markdown', codeBlocks: true, tables: true,
      outboundMedia: ['image', 'file', 'audio', 'video'], updates: 'stream',
      threads: 'none', decisions: 'native',
    }
  }
  private workspace: string

  /** Pending sync REST requests keyed by requestId. */
  private syncPending = new Map<string, {
    resolve: (resp: { content: string; media?: string[] }) => void
    reject: (error: unknown) => void
    chunks: string[]
    media: string[]
    timer: ReturnType<typeof setTimeout>
  }>()

  private sessionManager?: SessionManager
  private readonly subscriptions: string[] = []

  constructor(
    bus: Bus,
    opts: {
      allowFrom?: string[]
      workspace?: string
      sessionManager?: SessionManager
      realtime?: RealtimePublisher
    },
  ) {
    super(bus, opts.allowFrom, true)
    this.workspace = opts.workspace ?? '.'
    this.sessionManager = opts.sessionManager

    this.acceptToolResults = true

    this.subscriptions.push(this.bus.on('message.outbound', this.bindCallback((msg) => {
      if (msg.channel !== 'web') return
      opts.realtime?.chat(`web:${msg.chatId}`, outboundPayload(msg), msg.replyTo)
      this.pushToSync(msg)
    })))
    this.subscriptions.push(this.bus.on('session.message.appended', this.bindCallback(({ sessionId, physicalSessionId, message }) => {
      if (!sessionId.startsWith('web:') || message.role !== 'user') return
      const first = typeof message.content === 'string' ? message.content
        : message.content?.[0]?.type === 'text' ? message.content[0].text : ''
      if (!first || !/^<event\s/.test(first)) return
      const payload = { event: 'session_message', physicalSessionId, message }
      opts.realtime?.chat(sessionId, payload)
    })))
    this.subscriptions.push(this.bus.on('session.turn.finished', this.bindCallback(fact => {
      if (!fact.sessionId.startsWith('web:')) return
      const payload: RealtimeTurnFinishedPayload = {
        event: 'turn_finished', done: true, status: fact.status, turnId: fact.turnId,
      }
      opts.realtime?.chat(fact.sessionId, payload, fact.inputId)
    })))
  }

  async start(app: Hono): Promise<void> {
    for (const path of ['/api/chat/send', '/api/chat/message', '/api/chat/upload', '/api/chat/uploads/*', '/api/media']) {
      app.use(path, async (c, next) => {
        const ids: string[] = []
        if (c.req.method === 'GET' || c.req.method === 'HEAD') {
          const chatId = c.req.query('chatId')
          const sessionId = path === '/api/media' ? c.req.query('sessionId') : undefined
          if (path === '/api/media' && chatId !== undefined && sessionId !== undefined) {
            return c.json({ error: 'Specify either chatId or sessionId, not both' }, 400)
          }
          if (chatId) ids.push(`${this.name}:${chatId}`)
          if (sessionId) ids.push(sessionId)
        } else {
          let body: Record<string, unknown> | undefined
          try {
            if (path.endsWith('/upload')) {
              const form = await c.req.formData()
              body = { chatId: form.get('chatId'), parentSessionId: form.get('parentSessionId') }
            } else {
              const value: unknown = await c.req.json()
              if (isConfigObject(value)) body = value
            }
          } catch { /* The route reports malformed input. */ }
          for (const key of ['chatId', 'parentChatId'] as const) {
            if (typeof body?.[key] === 'string') ids.push(`${this.name}:${body[key]}`)
          }
          if (typeof body?.parentSessionId === 'string') ids.push(body.parentSessionId)
        }
        try { for (const id of ids) this.sessionManager?.assertFolderAccess?.(id) }
        catch (error) {
          if (error instanceof FolderError) return c.json({ error: error.code, message: error.message }, error.status)
          throw error
        }
        return next()
      })
    }
    // ── POST /api/chat/upload — save file into private session data ──
    app.post('/api/chat/upload', async (c) => {
      try {
        const formData = await c.req.formData()
        const file = formData.get('file')
        if (!file || !(file instanceof File)) {
          return c.json({
            error: 'No file provided. Use multipart form with "file" field.',
          }, 400)
        }

        const chatId = formData.get('chatId')
        if (typeof chatId !== 'string' || !chatId) {
          return c.json({
            error: 'Missing "chatId" field. Uploads are saved per session.',
          }, 400)
        }
        const sessionId = `${this.name}:${chatId}`
        const state = this.sessionManager?.getSessionState(sessionId)
        const parentSessionId = formData.get('parentSessionId')
        if (parentSessionId !== null && (typeof parentSessionId !== 'string' || !parentSessionId)) {
          return c.json({ error: 'Invalid parent session ID' }, 400)
        }
        const parent = !state && parentSessionId
          ? this.sessionManager?.getSessionState(parentSessionId)
          : undefined
        if (!state && parentSessionId && !parent) {
          return c.json({ error: 'Parent conversation not found' }, 404)
        }
        const workdir = resolveSessionLocations(
          this.workspace,
          state ?? parent ?? { sessionId },
          undefined,
          this.sessionManager?.workdirCapabilityLookup,
        ).workdir
        if (!workdir.available || workdir.locality === 'remote') {
          return c.json({ error: 'Upload unavailable' }, 409)
        }

        // Sanitize filename: keep only safe characters
        const rawName = file.name || 'upload'
        const ext = extname(rawName) || ''
        const baseName = rawName.replace(ext, '').replace(
          /[^a-zA-Z0-9_\-.\u4e00-\u9fff]/g,
          '_',
        )
        const safeName = `web_${randomUUID()}_${baseName}${ext}`

        const buf = new Uint8Array(await file.arrayBuffer())
        const relativePath = await saveToUploads(
          this.workspace,
          state?.workspaceRoot ?? sessionId,
          safeName,
          buf,
        )

        console.info(
          `[web] Uploaded file: ${relativePath} (${buf.byteLength} bytes)`,
        )
        return c.json({
          path: resolve(
            sessionWorkspacePath(this.workspace, state?.workspaceRoot ?? sessionId),
            relativePath,
          ),
          filename: file.name,
          size: buf.byteLength,
        })
      } catch {
        console.error('[web] Upload failed')
        return c.json({ error: 'Upload failed' }, 500)
      }
    })

    // ── GET /api/chat/uploads/* — serve files from a session's uploads dir ──
    app.get('/api/chat/uploads/:filename{.+}', async (c) => {
      const filename = c.req.param('filename')
      if (!filename || filename.includes('..')) {
        return c.json({ error: 'Invalid filename' }, 400)
      }

      const chatId = c.req.query('chatId')
      const sessionId = chatId ? `${this.name}:${chatId}` : undefined
      const state = sessionId ? this.sessionManager?.getSessionState(sessionId) : null
      if (sessionId) {
        const { workdir } = resolveSessionLocations(
          this.workspace, state ?? { sessionId }, undefined,
          this.sessionManager?.workdirCapabilityLookup,
        )
        if (!workdir.available || workdir.locality === 'remote') {
          return c.json({ error: 'Media unavailable' }, 404)
        }
      }
      const uploadsRoot = sessionId
        ? join(sessionWorkspacePath(this.workspace, state?.workspaceRoot ?? sessionId), 'uploads')
        : join(this.workspace, 'uploads')
      const filePath = await resolveSessionMediaPath(uploadsRoot, filename)
      if (!filePath) return c.json({ error: 'File not found' }, 404)
      return mediaFileResponse(filePath, c.req.raw, c.req.query('download') === '1')
    })

    // ── POST /api/chat/message — sync: send message, wait for full response ──
    app.post('/api/chat/message', async (c) => {
      const body = await c.req.json<{
        chatId?: string
        content: string
        senderId?: string
        media?: string[]
        timeoutMs?: number
      }>()

      if (!body.content && (!body.media || body.media.length === 0)) {
        return c.json({ error: 'content or media is required' }, 400)
      }

      const chatId = body.chatId ?? 'web-default'
      const requestId = crypto.randomUUID()
      const timeoutMs = body.timeoutMs ?? 120_000

      try {
        const completed = new Promise<
          { content: string; media?: string[] }
        >(
          (resolve, reject) => {
            const timer = setTimeout(this.bindCallback(() => {
              this.syncPending.delete(requestId)
              reject(new DOMException('Response timeout', 'TimeoutError'))
            }), timeoutMs)

            this.syncPending.set(requestId, {
              resolve,
              reject,
              chunks: [],
              media: [],
              timer,
            })
          },
        )
        const [, response] = await Promise.all([
          this.handleIncoming(
            body.senderId ?? 'web-user',
            chatId,
            body.content,
            requestId,
            { senderName: body.senderId ?? 'web-user' },
            body.media,
          ),
          completed,
        ])

        return c.json({
          requestId,
          chatId,
          content: response.content,
          media: response.media?.length ? response.media : undefined,
        })
      } catch (err) {
        this.syncPending.get(requestId)?.reject(err)
        const message = err instanceof Error ? err.message : 'Internal error'
        const status = err instanceof DOMException && err.name === 'TimeoutError'
          ? 504
          : err instanceof ChannelAdmissionError ? err.status : 503
        return c.json({ error: message }, status)
      } finally {
        const pending = this.syncPending.get(requestId)
        if (pending) clearTimeout(pending.timer)
        this.syncPending.delete(requestId)
      }
    })

    // ── POST /api/chat/send — admit a message; output uses /api/live ──
    app.post('/api/chat/send', async (c) => {
      let rawBody: unknown
      try {
        rawBody = await c.req.json()
      } catch {
        return c.json({ error: 'invalid_json' }, 400)
      }
      if (!isConfigObject(rawBody)) return c.json({ error: 'invalid_request' }, 400)
      let configPatch: SessionConfigPatch | undefined
      try {
        if ('config' in rawBody) configPatch = parseSessionConfigPatch(rawBody.config, true)
      } catch (error) {
        if (!(error instanceof TypeError)) throw error
        return c.json({ error: error.message }, 400)
      }
      const {
        chatId,
        content,
        senderId,
        media,
        parentChatId,
        parentSessionId,
        forkAt,
        retry,
        stream,
      } = rawBody
      if (typeof chatId !== 'string' || !chatId ||
          (content !== undefined && typeof content !== 'string') ||
          (senderId !== undefined && typeof senderId !== 'string') ||
          (parentChatId !== undefined && typeof parentChatId !== 'string') ||
          (parentSessionId !== undefined && typeof parentSessionId !== 'string') ||
          (forkAt !== undefined && (typeof forkAt !== 'number' || !Number.isSafeInteger(forkAt) || forkAt < 0)) ||
          (retry !== undefined && typeof retry !== 'boolean') ||
          (stream !== undefined && typeof stream !== 'boolean') ||
          (media !== undefined && (!Array.isArray(media) || !media.every(item => typeof item === 'string')))) {
        return c.json({ error: 'invalid_request' }, 400)
      }
      if (!content && !retry && (!media || media.length === 0)) {
        return c.json({ error: 'chatId and content or media are required' }, 400)
      }
      if (stream === true) {
        return c.json({
          error: 'stream_retired',
          message: 'Subscribe to /api/live and send without stream:true. No message was submitted.',
        }, 410)
      }

      const requestId = crypto.randomUUID()

      const sessionId = `${this.name}:${chatId}`
      const state = await this.sessionManager?.getSessionState(sessionId)
      // Parent linkage must exist before admission.
      if (!state) {
        if (parentChatId) {
          await this.sessionManager?.buildSession(sessionId, {
            id: `${this.name}:${parentChatId}`,
            ...(forkAt != null ? { index: forkAt } : {}),
          }, { parentSessionId: null })
        } else if (parentSessionId) {
          await this.sessionManager?.buildSession(sessionId, {
            id: parentSessionId,
          }, { parentSessionId: null })
        }
      }

      if (configPatch) {
        if (!this.sessionManager) return c.json({ error: 'sessions_unavailable' }, 501)
        try {
          await this.sessionManager.applySessionConfigPatch(sessionId, configPatch, true)
        } catch (error) {
          return c.json({ error: error instanceof Error ? error.message : 'config_update_failed' }, 500)
        }
      }

      try {
        const receipt = await this.handleIncoming(
          senderId ?? 'web-user',
          chatId,
          content ?? '',
          requestId,
          {
            senderName: senderId ?? 'web-user',
            ...(retry ? { retry: true } : {}),
          },
          media,
        )
        return c.json({ requestId, chatId, ...(receipt.commandReceipt ? { commandReceipt: receipt.commandReceipt } : {}) })
      } catch (err) {
        return c.json(
          { error: err instanceof Error ? err.message : 'Message admission failed' },
          err instanceof ChannelAdmissionError ? err.status : 503,
        )
      }
    })

    app.get('/api/chat/events', (c) => c.json({
      error: 'stream_retired', message: 'Subscribe to chat topics through /api/live.',
    }, 410))

    // ── GET /api/chat/session?chatId=<id> — retrieve session context + history ──
    app.get('/api/chat/session', async (c) => {
      const chatId = c.req.query('chatId')
      if (!chatId) return c.json({ error: 'chatId is required' }, 400)

      try {
        const sessionId = `${this.name}:${chatId}`
        const { systemPrompt, tools } = await this.sessionManager!.getContext({
          sessionId,
          channel: this.name,
        })
        const { messages: history } = await this.sessionManager!.getHistory(
          sessionId,
        )
        const commandResults = await this.sessionManager!.getCommandResults(sessionId)
        const decisionRecords = this.sessionManager!.getSessionState(sessionId)
          ? await this.sessionManager!.getYieldRecords(sessionId) : []
        return c.json({ chatId, systemPrompt, history: history || [], commandResults, decisionRecords, tools })
      } catch (error) {
        console.error('[web] Failed to retrieve session:', error)
        return c.json({ error: 'Failed to retrieve session' }, 500)
      }
    })

    // Explicit logical session IDs expose private uploads, never the session workdir.
    app.get('/api/media', async (c) => {
      const rawPath = c.req.query('path')
      if (!rawPath) return c.json({ error: 'path is required' }, 400)

      const chatId = c.req.query('chatId')
      const explicitSessionId = c.req.query('sessionId')
      if (!(explicitSessionId ?? chatId)) {
        return c.json({ error: 'chatId or sessionId is required' }, 400)
      }

      const sessionId = explicitSessionId ?? `${this.name}:${chatId}`
      const existingState = this.sessionManager?.getSessionState(sessionId)
      // SessionManager is Project-bound and validates loaded SNS identities against that Project.
      if (explicitSessionId !== undefined && existingState?.sessionId !== sessionId) {
        return c.json({ error: 'Session not found' }, 404)
      }
      const state = existingState ?? { sessionId }
      const locations = resolveSessionLocations(
        this.workspace,
        state,
        undefined,
        this.sessionManager?.workdirCapabilityLookup,
      )
      const workdir = locations.workdir
      if (!workdir.available || workdir.locality === 'remote') {
        return c.json({ error: 'Media unavailable' }, 404)
      }

      const privateUpload = explicitSessionId !== undefined || isAbsolute(rawPath)
      const mediaRoot = privateUpload
        ? join(locations.sessionDataDir, 'uploads')
        : workdir.path
      if (privateUpload && !await resolveSessionMediaPath(locations.sessionDataDir, 'uploads')) {
        return c.json({ error: 'Media unavailable' }, 404)
      }
      const mediaPath = privateUpload
        ? relative(mediaRoot, isAbsolute(rawPath) ? rawPath : resolve(locations.sessionDataDir, rawPath))
        : rawPath
      const resolved = await resolveSessionMediaPath(mediaRoot, mediaPath)
      if (!resolved) return c.json({ error: 'Media unavailable' }, 404)

      return mediaFileResponse(resolved, c.req.raw, c.req.query('download') === '1')
    })

    console.info(
      '[web] Web channel started — POST /api/chat/send, GET /api/chat/session, GET /api/media; realtime via /api/live',
    )
  }

  async stop(): Promise<void> {
    this.setAccepting(false)
    for (const subscription of this.subscriptions.splice(0)) this.bus.off(subscription)
    for (const [id, p] of this.syncPending) {
      clearTimeout(p.timer)
      p.reject(new Error('Web channel stopped'))
      this.syncPending.delete(id)
    }
  }

  async send(_msg: OutboundMessage): Promise<string | null> {
    // The outbound subscription publishes to realtime and pending sync requests.
    return null
  }

  async update(
    _messageId: string,
    _chatId: string,
    _content: string,
    _media?: string[],
  ): Promise<void> {
    // Progressive updates use the same outbound subscription.
  }

  // ── Internal ──────────────────────────────────────────────────────

  private pushToSync(msg: OutboundMessage): void {
    const requestId = msg.replyTo
    if (!requestId) return

    const pending = this.syncPending.get(requestId)
    if (!pending) return

    if (msg.content) pending.chunks.push(msg.content)
    if (msg.media) pending.media.push(...msg.media)

    if (msg.done) {
      clearTimeout(pending.timer)
      this.syncPending.delete(requestId)
      pending.resolve({
        content: pending.chunks.join('\n'),
        media: pending.media.length ? pending.media : undefined,
      })
    }
  }
}
