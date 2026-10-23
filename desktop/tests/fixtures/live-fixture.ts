import { Hono } from 'hono'
import { getRequestListener } from '@hono/node-server'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { RealtimeHub, registerRealtimeRoute, type RealtimePublisher } from '../../../src/realtime/hub.ts'

type Row = { id: number } & Record<string, unknown>
type ChatPayload = {
  event?: 'response' | 'tool_call' | 'tool_result' | 'session_message' | 'turn_finished'
  content?: string
  done?: boolean
  toolCallId?: string
  toolName?: string
  toolCall?: { name: string; arguments: unknown }
  message?: Record<string, unknown>
}

/** Real transport and replay journal with disposable, in-memory telemetry. */
export class LiveFixture {
  readonly rows: Record<'logs' | 'spans', Row[]> = { logs: [], spans: [] }
  readonly responses = new Set<ServerResponse>()
  readonly resets: string[] = []
  readonly errors: string[] = []
  readonly diagnostics: string[] = []
  readonly connections: Array<{ topics: string; closed: boolean }> = []
  readonly histories = new Map<string, Record<string, unknown>[]>()
  readonly activeRequests = new Map<string, string>()
  private readonly pending = new Map<string, { content: string; timestamp: string }>()
  private readonly toolCalls = new Map<string, string>()
  private nextRequest = 0
  private nextTool = 0
  hub!: RealtimeHub
  publisher!: RealtimePublisher
  other!: RealtimePublisher
  private api!: Hono
  private readonly listener = getRequestListener(async request => {
    const result = await this.api.fetch(request)
    if (!result.body) return result
    const body = result.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform: (value, controller) => {
        const reset = new TextDecoder().decode(value).match(/"type":"reset".*"reason":"([^"]+)"/)
        if (reset) this.resets.push(reset[1])
        controller.enqueue(value)
      },
    }))
    return new Response(body, { status: result.status, headers: result.headers })
  })

  constructor() { this.restart() }

  restart() {
    this.hub?.close()
    this.hub = new RealtimeHub({ journalCount: 32, heartbeatMs: 1000, telemetryMs: 50, diagnostic: message => this.diagnostics.push(message) })
    this.publisher = this.hub.registerProject('default', {
      latest: kind => this.rows[kind].at(-1)?.id ?? 0,
      query: (kind, afterId, limit) => this.rows[kind].filter(row => row.id > afterId).slice(0, limit),
    })
    this.other = this.hub.registerProject('other')
    this.api = new Hono()
    registerRealtimeRoute(this.api, this.hub, () => true)
  }

  disconnect() { for (const response of this.responses) response.destroy() }

  close() {
    this.hub.close()
    this.disconnect()
    this.activeRequests.clear()
    this.pending.clear()
  }

  admit(chatId: string) {
    const requestId = `fixture-request-${++this.nextRequest}`
    this.activeRequests.set(`web:${chatId}`, requestId)
    this.publisher.invalidateSessions(`web:${chatId}`)
    return { requestId, chatId }
  }

  history(sessionId: string) {
    let history = this.histories.get(sessionId)
    if (!history) this.histories.set(sessionId, history = [])
    return history
  }

  /** Persist the same synthetic output returned by subsequent history snapshots. */
  chat(sessionId: string, payload: ChatPayload, requestId = this.activeRequests.get(sessionId)) {
    const history = this.history(sessionId)
    const flush = () => {
      const pending = this.pending.get(sessionId)
      if (pending) history.push({ role: 'assistant', ...pending })
      this.pending.delete(sessionId)
    }
    if (payload.event === 'tool_call') {
      flush()
      const id = payload.toolCallId ?? `fixture-tool-${++this.nextTool}`
      this.toolCalls.set(sessionId, id)
      payload = { ...payload, toolCallId: id }
      history.push({ role: 'assistant', content: '', timestamp: new Date().toISOString(), tool_calls: [{
        id, type: 'function', function: { name: payload.toolCall?.name ?? payload.toolName, arguments: JSON.stringify(payload.toolCall?.arguments ?? {}) },
      }] })
    } else if (payload.event === 'tool_result') {
      payload = { ...payload, toolCallId: payload.toolCallId ?? this.toolCalls.get(sessionId) }
      history.push({ role: 'tool', tool_call_id: payload.toolCallId, name: payload.toolName, content: payload.content ?? '', timestamp: new Date().toISOString() })
    } else if (payload.event === 'session_message') {
      flush()
      if (payload.message) history.push(payload.message)
    } else if (payload.content) {
      const pending = this.pending.get(sessionId) ?? { content: '', timestamp: new Date().toISOString() }
      pending.content += payload.content
      this.pending.set(sessionId, pending)
    }
    if (payload.done) flush()
    this.publisher.chat(sessionId, payload, requestId)
  }

  finish(sessionId: string, status: 'completed' | 'failed' | 'cancelled' = 'completed') {
    const requestId = this.activeRequests.get(sessionId)
    this.chat(sessionId, { event: 'response', done: true }, requestId)
    this.activeRequests.delete(sessionId)
    this.publisher.chat(sessionId, { event: 'turn_finished', done: true, status, turnId: `turn-${requestId ?? ++this.nextRequest}` }, requestId)
    this.publisher.invalidateSessions(sessionId)
  }

  handle(request: IncomingMessage, response: ServerResponse): boolean {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/[^/]+(?=\/)/, '')
    const idleIo = request.method === 'GET' && path === '/api/io/runs'
      ? { runs: [] }
      : request.method === 'POST' && (path === '/api/io/clients' || /^\/api\/io\/clients\/[^/]+\/heartbeat$/.test(path))
        ? { clientToken: 'synthetic-idle-client', ok: true } : undefined
    if (idleIo) {
      request.resume()
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(idleIo))
      return true
    }
    if (url.pathname !== '/api/live') return false
    const connection = { topics: url.searchParams.get('topics') ?? '', closed: false }
    this.connections.push(connection)
    this.responses.add(response)
    response.once('close', () => { connection.closed = true; this.responses.delete(response) })
    void Promise.resolve(this.listener(request, response)).catch(error => {
      this.errors.push(String(error))
      response.destroy()
    })
    return true
  }
}
