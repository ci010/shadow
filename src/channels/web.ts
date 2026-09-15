import { AbstractChannel, ChannelAdmissionError } from './base.ts'
import type { ChannelCapabilities } from './capabilities.ts'
import { randomUUID } from 'node:crypto'
import { readFile, realpath } from 'node:fs/promises'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { Hono } from 'hono'
import { saveToUploads, sessionWorkspacePath } from '../utils/paths.ts'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { resolveSessionLocations } from '../sessions/locality.ts'
import { ProjectError } from '../projects/registry.ts'
import { isConfigObject, parseSessionConfigPatch, type SessionConfigPatch } from '../sessions/config-patch.ts'

function escapesRoot(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') ||
    isAbsolute(rel)
}

export async function resolveSessionMediaPath(
  sessionRoot: string,
  mediaPath: string,
): Promise<string | null> {
  if (!mediaPath || isAbsolute(mediaPath)) return null

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
  } catch {
    return null
  }
}

/**
 * Web channel — exposes HTTP+SSE endpoints so browser frontends
 * (like dag-chat) can send messages and receive streamed responses.
 *
 * Endpoints:
 *  POST /api/chat/send     — send message (with optional media refs), returns SSE stream
 *  POST /api/chat/message  — send message, wait for full response (sync REST)
 *  POST /api/chat/upload   — upload file/image, returns absolute private-session path
 *  GET  /api/chat/uploads/* — serve uploaded / outbound media files
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

  /**
   * Pending SSE connections keyed by `requestId` (the messageId we set on
   * the inbound message). The session loop sets `replyTo` on outbound
   * messages to match this, so we can correlate response → request.
   */
  private pending = new Map<string, ReadableStreamDefaultController>()

  /** Pending sync REST requests keyed by requestId. */
  private syncPending = new Map<string, {
    resolve: (resp: { content: string; media?: string[] }) => void
    reject: (error: unknown) => void
    chunks: string[]
    media: string[]
    timer: ReturnType<typeof setTimeout>
  }>()

  /**
   * Persistent per-chat SSE connections keyed by `chatId`. These stay open for
   * the lifetime of an open browser tab (via GET /api/chat/events) and receive
   * background/unsolicited messages — e.g. cron ticks, scheduled self-awake
   * events, or subagent replies — that are not tied to an active request.
   */
  private eventStreams = new Map<string, Set<ReadableStreamDefaultController>>()

  /** Keep-alive timer that periodically pings open event streams. */
  private keepAliveTimer?: number

  private sessionManager?: SessionManager
  private readonly subscriptions: string[] = []

  constructor(
    bus: Bus,
    opts: {
      allowFrom?: string[]
      workspace?: string
      sessionManager?: SessionManager
    },
  ) {
    super(bus, opts.allowFrom, true)
    this.workspace = opts.workspace ?? '.'
    this.sessionManager = opts.sessionManager

    this.acceptToolResults = true

    // Subscribe to all outbound messages and route to SSE / sync connections
    this.subscriptions.push(this.bus.on('message.outbound', this.bindCallback((msg) => {
      if (msg.channel !== 'web') return
      const toRequest = this.pushToSSE(msg)
      const toSync = this.pushToSync(msg)
      // Background/unsolicited messages (no matching active request) are pushed
      // to the persistent per-chat event stream so open browsers receive them
      // live without a manual refresh.
      if (!toRequest && !toSync) this.pushToEventStream(msg)
    })))
    this.subscriptions.push(this.bus.on('session.message.appended', this.bindCallback(({ sessionId, physicalSessionId, message }) => {
      if (!sessionId.startsWith('web:') || message.role !== 'user') return
      const first = typeof message.content === 'string' ? message.content
        : message.content?.[0]?.type === 'text' ? message.content[0].text : ''
      if (!first || !/^<event\s/.test(first)) return
      this.broadcastEvent(sessionId.slice(4), { event: 'session_message', physicalSessionId, message })
    })))
  }

  async start(app: Hono): Promise<void> {
    for (const path of ['/api/chat/send', '/api/chat/message', '/api/chat/upload', '/api/media']) {
      app.use(path, async (c, next) => {
        const ids: string[] = []
        if (c.req.method === 'GET') {
          const chatId = c.req.query('chatId')
          if (chatId) ids.push(`${this.name}:${chatId}`)
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
        try { for (const id of ids) this.sessionManager?.assertProjectAccess?.(id) }
        catch (error) {
          if (error instanceof ProjectError) return c.json({ error: error.code, message: error.message }, error.status)
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
      const uploadsRoot = sessionId
        ? join(sessionWorkspacePath(this.workspace, state?.workspaceRoot ?? sessionId), 'uploads')
        : join(this.workspace, 'uploads')
      const filePath = await resolveSessionMediaPath(uploadsRoot, filename)
      if (!filePath) return c.json({ error: 'File not found' }, 404)
      try {
        const data = new Uint8Array(await readFile(filePath))
        const ext = extname(filename).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
          '.avif': 'image/avif',
          '.pdf': 'application/pdf',
          '.doc': 'application/msword',
          '.docx':
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.xls': 'application/vnd.ms-excel',
          '.xlsx':
            'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          '.ppt': 'application/vnd.ms-powerpoint',
          '.pptx':
            'application/vnd.openxmlformats-officedocument.presentationml.presentation',
          '.txt': 'text/plain',
          '.csv': 'text/csv',
          '.json': 'application/json',
          '.mp4': 'video/mp4',
          '.mp3': 'audio/mpeg',
          '.wav': 'audio/wav',
        }
        const contentType = mimeMap[ext] || 'application/octet-stream'

        return new Response(data, {
          headers: {
            'Content-Type': contentType,
            'Content-Disposition': `inline; filename="${filename}"`,
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch {
        return c.json({ error: 'File not found' }, 404)
      }
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

    // ── POST /api/chat/send — accept a message and return SSE stream ──
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

      const requestId = crypto.randomUUID()

      const sessionId = `${this.name}:${chatId}`
      const state = await this.sessionManager?.getSessionState(sessionId)
      // Set parent linkage before creating the stream (async, must happen before inbound)
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

      // Admission-only submit (steering / queuing). Used when a turn is
      // already active in the browser: we don't open a dedicated SSE stream —
      // the message is steered into the running turn (its reply flows through
      // the active request's stream) or, if the turn is aborted/restarted,
      // through the persistent GET /api/chat/events stream. This avoids
      // registering a per-request controller that would never receive `done`.
      if (stream === false) {
        try {
          await this.handleIncoming(
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
          return c.json({ requestId, chatId })
        } catch (err) {
          return c.json(
            { error: err instanceof Error ? err.message : 'Message admission failed' },
            err instanceof ChannelAdmissionError ? err.status : 503,
          )
        }
      }

      // Create SSE stream
      const sseStream = new ReadableStream({
        start: (controller) => {
          // Register before admission so even an immediate response is captured.
          this.pending.set(requestId, controller)
        },
        cancel: () => {
          this.pending.delete(requestId)
        },
      })

      try {
        await this.handleIncoming(
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
      } catch (err) {
        this.pending.delete(requestId)
        await sseStream.cancel()
        return c.json(
          { error: err instanceof Error ? err.message : 'Message admission failed' },
          err instanceof ChannelAdmissionError ? err.status : 503,
        )
      }

      return new Response(sseStream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

    // ── GET /api/chat/events?chatId=<id> — persistent SSE for background pushes ──
    app.get('/api/chat/events', (c) => {
      const chatId = c.req.query('chatId')
      if (!chatId) return c.json({ error: 'chatId is required' }, 400)

      const encoder = new TextEncoder()
      let selfController: ReadableStreamDefaultController | null = null
      const stream = new ReadableStream({
        start: (controller) => {
          selfController = controller
          let set = this.eventStreams.get(chatId)
          if (!set) {
            set = new Set()
            this.eventStreams.set(chatId, set)
          }
          set.add(controller)
          // Initial comment so the client knows the stream is live.
          controller.enqueue(encoder.encode(': connected\n\n'))
        },
        cancel: () => {
          const set = this.eventStreams.get(chatId)
          if (!set || !selfController) return
          set.delete(selfController)
          if (set.size === 0) this.eventStreams.delete(chatId)
        },
      })

      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        },
      })
    })

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
        return c.json({ chatId, systemPrompt, history: history || [], tools })
      } catch (error) {
        console.error('[web] Failed to retrieve session:', error)
        return c.json({ error: 'Failed to retrieve session' }, 500)
      }
    })

    // ── GET /api/media?chatId=<id>&path=<relative> — serve session media files ──
    app.get('/api/media', async (c) => {
      const rawPath = c.req.query('path')
      if (!rawPath) return c.json({ error: 'path is required' }, 400)

      const chatId = c.req.query('chatId')
      if (!chatId) return c.json({ error: 'chatId is required' }, 400)

      const sessionId = `${this.name}:${chatId}`
      const state = this.sessionManager?.getSessionState(sessionId) ?? {
        sessionId,
      }
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

      const privateUpload = isAbsolute(rawPath)
      const mediaRoot = privateUpload
        ? join(locations.sessionDataDir, 'uploads')
        : workdir.path
      const mediaPath = privateUpload ? relative(mediaRoot, rawPath) : rawPath
      const resolved = await resolveSessionMediaPath(mediaRoot, mediaPath)
      if (!resolved) return c.json({ error: 'Media unavailable' }, 404)

      try {
        const data = new Uint8Array(await readFile(resolved))
        const ext = extname(resolved).toLowerCase()
        const mimeMap: Record<string, string> = {
          '.jpg': 'image/jpeg',
          '.jpeg': 'image/jpeg',
          '.png': 'image/png',
          '.gif': 'image/gif',
          '.webp': 'image/webp',
          '.svg': 'image/svg+xml',
          '.bmp': 'image/bmp',
          '.avif': 'image/avif',
          '.pdf': 'application/pdf',
        }
        return new Response(data, {
          headers: {
            'Content-Type': mimeMap[ext] || 'application/octet-stream',
            'Cache-Control': 'public, max-age=3600',
            'Access-Control-Allow-Origin': '*',
          },
        })
      } catch {
        return c.json({ error: 'File not found' }, 404)
      }
    })

    console.info(
      '[web] Web channel started — POST /api/chat/send, GET /api/chat/events, GET /api/chat/session, GET /api/media',
    )

    // Periodically ping open event streams so proxies/browsers keep them alive
    // and closed connections get pruned.
    this.keepAliveTimer = setInterval(this.bindCallback(() => {
      const encoder = new TextEncoder()
      for (const [chatId, set] of this.eventStreams) {
        for (const controller of set) {
          try {
            controller.enqueue(encoder.encode(': ping\n\n'))
          } catch {
            set.delete(controller)
          }
        }
        if (set.size === 0) this.eventStreams.delete(chatId)
      }
    }), 25_000) as unknown as number
  }

  async stop(): Promise<void> {
    this.setAccepting(false)
    for (const subscription of this.subscriptions.splice(0)) this.bus.off(subscription)
    if (this.keepAliveTimer !== undefined) {
      clearInterval(this.keepAliveTimer)
      this.keepAliveTimer = undefined
    }

    for (const controller of this.pending.values()) {
      try {
        controller.close()
      } catch { /* already closed */ }
    }
    this.pending.clear()

    for (const set of this.eventStreams.values()) {
      for (const controller of set) {
        try {
          controller.close()
        } catch { /* already closed */ }
      }
    }
    this.eventStreams.clear()

    for (const [id, p] of this.syncPending) {
      clearTimeout(p.timer)
      p.reject(new Error('Web channel stopped'))
      this.syncPending.delete(id)
    }
  }

  async send(msg: OutboundMessage): Promise<string | null> {
    // Delivery is handled by onOutbound → pushToSSE.
    // ChannelManager.dispatchOutbound still calls this, return a stable id.
    return null
  }

  async update(
    _messageId: string,
    _chatId: string,
    _content: string,
    _media?: string[],
  ): Promise<void> {
    // Progressive updates go through pushToSSE via onOutbound subscription.
  }

  // ── Internal ──────────────────────────────────────────────────────

  private pushToSSE(msg: OutboundMessage): boolean {
    // Match by replyTo (set to our requestId by the session loop)
    const requestId = msg.replyTo
    if (!requestId) return false

    const controller = this.pending.get(requestId)
    if (!controller) return false

    try {
      const data = JSON.stringify({
        event: msg.event ?? 'response',
        content: msg.content,
        done: msg.done ?? false,
        media: msg.media,
        usage: msg.usage,
        toolCall: msg.toolCall,
        toolCallId: msg.toolCallId,
        toolName: msg.toolName,
      })
      const encoder = new TextEncoder()
      controller.enqueue(encoder.encode(`data: ${data}\n\n`))

      if (msg.done) {
        controller.close()
        this.pending.delete(requestId)
      }
    } catch {
      this.pending.delete(requestId)
    }
    return true
  }

  private pushToSync(msg: OutboundMessage): boolean {
    const requestId = msg.replyTo
    if (!requestId) return false

    const pending = this.syncPending.get(requestId)
    if (!pending) return false

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
    return true
  }

  /**
   * Push a background/unsolicited message (cron tick, scheduled self-awake,
   * subagent reply, …) to every persistent event stream open for its chat, so
   * connected browsers render it live without a manual refresh.
   */
  private pushToEventStream(msg: OutboundMessage): void {
    this.broadcastEvent(msg.chatId, {
      event: msg.event ?? 'response',
      content: msg.content,
      done: msg.done ?? false,
      media: msg.media,
      usage: msg.usage,
      toolCall: msg.toolCall,
      toolCallId: msg.toolCallId,
      toolName: msg.toolName,
    })
  }

  private broadcastEvent(chatId: string, payload: unknown): void {
    const set = this.eventStreams.get(chatId)
    if (!set || set.size === 0) return
    const data = JSON.stringify(payload)
    const encoder = new TextEncoder()
    const chunk = encoder.encode(`data: ${data}\n\n`)

    for (const controller of set) {
      try {
        controller.enqueue(chunk)
      } catch {
        set.delete(controller)
      }
    }
    if (set.size === 0) this.eventStreams.delete(chatId)
  }
}
