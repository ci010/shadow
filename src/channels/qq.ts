/**
 * QQ Bot channel (官方机器人 / 群聊 + 单聊 + 频道).
 *
 * Uses the QQ Bot Open Platform API v2:
 *   - App access token minted from AppID + AppSecret
 *   - WebSocket gateway for receiving events (no public IP required)
 *   - REST API for sending messages
 *
 * Docs:
 *   - https://bot.q.qq.com/wiki/develop/api-v2/
 *   - https://github.com/tencent-connect/bot-node-sdk
 *
 * Raw `fetch` + `WebSocket` implementation (no npm SDK),
 * mirroring the Discord channel's gateway approach.
 */

import { extname } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import type { ChannelMessageMetadata, OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import { Span } from '../otel/tracing.ts'
import { readMediaFile, saveToUploads } from '../utils/paths.ts'
import { RingSet } from '../utils/ring-set.ts'
import { errMsg } from '../utils/truncate.ts'
import { AbstractChannel, ChannelAdmissionError } from './base.ts'
import { unavailableCapabilities, type ChannelCapabilities } from './capabilities.ts'
import { QQDeliveryError, QQPassiveReplies, qqResponseError } from './qq-replies.ts'
import {
  decodeQQGatewayPayload, qqAttachmentSources, qqInboundDiagnostics, qqIncomingContent,
  qqMessageIndices, QQReferences, type QQGatewayPayload,
} from './qq-inbound.ts'

// ---------------------------------------------------------------------------
// Endpoints & constants
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'

// Gateway intents (bitmask). See https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
const INTENT_GUILDS = 1 << 0
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30 // AT_MESSAGE_CREATE
const INTENT_GROUP_AND_C2C_EVENT = 1 << 25 // GROUP_MESSAGE_CREATE | GROUP_AT_MESSAGE_CREATE | C2C_MESSAGE_CREATE
const DEFAULT_INTENTS = INTENT_GUILDS | INTENT_PUBLIC_GUILD_MESSAGES |
  INTENT_GROUP_AND_C2C_EVENT

// Gateway opcodes (identical model to Discord)
const OP_DISPATCH = 0
const OP_HEARTBEAT = 1
const OP_IDENTIFY = 2
const OP_RESUME = 6
const OP_RECONNECT = 7
const OP_INVALID_SESSION = 9
const OP_HELLO = 10
const OP_HEARTBEAT_ACK = 11

// Rich-media file types for the group/C2C upload endpoint
const FILE_TYPE_IMAGE = 1
const FILE_TYPE_VIDEO = 2
const FILE_TYPE_AUDIO = 3
const FILE_TYPE_FILE = 4

// Outbound message types
const MSG_TYPE_TEXT = 0
const MSG_TYPE_MARKDOWN = 2
const MSG_TYPE_MEDIA = 7

const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
const VIDEO_EXTS = new Set(['.mp4', '.mov', '.avi', '.mkv'])
const AUDIO_EXTS = new Set(['.silk', '.mp3', '.wav', '.amr', '.opus'])

// ---------------------------------------------------------------------------
// ChatId encoding
// ---------------------------------------------------------------------------
//
// QQ has four distinct send targets that require different endpoints. We encode
// the target type as a prefix on `chatId` so `send()` can route correctly:
//   group:<group_openid>   → POST /v2/groups/<id>/messages
//   c2c:<user_openid>      → POST /v2/users/<id>/messages
//   channel:<channel_id>   → POST /channels/<id>/messages   (guild text channel)
//   dms:<guild_id>         → POST /dms/<id>/messages        (guild direct message)

type QQTarget =
  | { kind: 'group'; id: string }
  | { kind: 'c2c'; id: string }
  | { kind: 'channel'; id: string }
  | { kind: 'dms'; id: string }

function parseChatId(chatId: string): QQTarget | null {
  const idx = chatId.indexOf(':')
  if (idx === -1) return null
  const kind = chatId.slice(0, idx)
  const id = chatId.slice(idx + 1)
  if (!id) return null
  switch (kind) {
    case 'group':
      return { kind, id }
    case 'c2c':
      return { kind, id }
    case 'channel':
      return { kind, id }
    case 'dms':
      return { kind, id }
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface QQChannelOptions {
  /** Bot AppID from the QQ Bot platform. */
  appId: string
  /** Bot AppSecret (client secret). */
  secret: string
  /** Bot token (legacy guild API). Optional for the v2 group/C2C API. */
  token?: string
  /** Use the sandbox API endpoint for testing. */
  sandbox?: boolean
  /** Gateway intents bitmask override. */
  intents?: number
  /** Render outbound messages as QQ Markdown (msg_type 2). Defaults to true. */
  markdown?: boolean
  /** Group messages are recorded either way; defaults to triggering only on mentions. */
  triggerMode?: 'all' | 'mention'
  allowFrom?: string[]
  /** Workspace root path — downloaded attachments are cached in the owning session's uploads directory. */
  workspace?: string
  /** Group / channel IDs that have admin privileges. DMs are admin by default. */
  adminChats?: string[]
}

// ---------------------------------------------------------------------------
// QQChannel
// ---------------------------------------------------------------------------

export class QQChannel extends AbstractChannel {
  readonly name = 'qq'

  override getCapabilities(chatId: string): ChannelCapabilities {
    const target = parseChatId(chatId)
    if (!target) return unavailableCapabilities()
    const v2 = target.kind === 'group' || target.kind === 'c2c'
    return {
      conversation: target.kind === 'c2c' || target.kind === 'dms' ? 'direct' : 'group',
      format: this.markdown ? 'markdown' : 'plain',
      codeBlocks: false, tables: false,
      outboundMedia: v2 ? ['image', 'file', 'video', 'audio'] : ['image'],
      updates: 'none', threads: 'none', decisions: 'text',
    }
  }

  // QQ cannot edit messages. GROUP/C2C delivery is additionally final-only.
  override update = undefined

  override async onMessage(msg: OutboundMessage): Promise<void> {
    const target = parseChatId(msg.chatId)
    if (target?.kind === 'group' || target?.kind === 'c2c') {
      if (msg.event !== 'response' || (!msg.done && !msg.yieldRequest)) return
    }
    await super.onMessage(msg)
  }

  private appId: string
  private secret: string
  private botToken: string
  private apiBase: string
  private intents: number
  private markdown: boolean
  private triggerMode: 'all' | 'mention'
  private workspace: string

  // Access token cache
  private accessToken: string | null = null
  private tokenExpiresAt = 0

  // WebSocket state
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sessionId: string | null = null
  private seq: number | null = null
  private gatewayUrl: string | null = null
  private stopping = false
  private controller = new AbortController()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private identifyTimer?: ReturnType<typeof setTimeout>
  private heartbeatAcknowledged = true
  private botUserId: string | null = null

  // Dedup recently seen message IDs (gateway may redeliver)
  private _seenIds = new RingSet<string>(200)

  // Legacy guild behavior only. GROUP/C2C must carry their exact source ID.
  private _lastMsgId = new Map<string, string>()
  private passiveReplies = new QQPassiveReplies()
  private references = new QQReferences()

  constructor(bus: Bus, opts: QQChannelOptions) {
    super(bus, opts.allowFrom, false, opts.adminChats)
    this.appId = opts.appId
    this.secret = opts.secret
    this.botToken = opts.token ?? ''
    this.apiBase = opts.sandbox ? SANDBOX_API_BASE : API_BASE
    this.intents = opts.intents ?? DEFAULT_INTENTS
    this.markdown = opts.markdown ?? true
    this.triggerMode = opts.triggerMode ?? 'mention'
    this.workspace = opts.workspace ?? '.'
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @Span('QQChannel.start')
  async start(_app: Hono): Promise<void> {
    if (!this.appId || !this.secret) {
      throw new Error('QQ credentials are required')
    }
    this.controller = new AbortController()
    this.setAccepting(true)
    this.reportState('connecting')
    this.stopping = false
    this.botUserId = null

    console.info('[qq] Connecting to QQ Bot gateway...')
    await this.connect()
  }

  @Span('QQChannel.stop')
  stop(): Promise<void> {
    this.stopping = true
    this.setAccepting(false)
    this.controller.abort()
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.identifyTimer)
    this.reconnectTimer = undefined
    this.identifyTimer = undefined
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    try {
      if (this.ws) {
        this.ws.onopen = this.ws.onmessage = this.ws.onclose = this.ws.onerror = null
        this.ws.close()
      }
    } catch {
      // ignore
    }
    this.ws = null
    this.accessToken = null
    this.sessionId = null
    this.seq = null
    this.passiveReplies.clear()
    this._lastMsgId.clear()
    this.references.clear()
    this.reportState('disconnected')
    console.info('[qq] Channel stopped')
    return Promise.resolve()
  }

  // ── Access token management ────────────────────────────────────────────────

  /**
   * Return a valid app access token, refreshing it if missing or near expiry.
   * Tokens are minted from AppID + AppSecret and live ~2 hours.
   */
  private async getAccessToken(): Promise<string> {
    const now = Date.now()
    if (this.accessToken && now < this.tokenExpiresAt - 60_000) {
      return this.accessToken
    }

    const res = await this.request(TOKEN_URL, {
      signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`QQ token request failed: status=${res.status}`)
    }
    const data = await res.json().catch(() => {
      throw new Error('QQ token response returned invalid JSON')
    }) as {
      access_token?: string
      expires_in?: number | string
      message?: string
    }
    if (!data.access_token) {
      throw new Error(
        'QQ token response missing access token',
      )
    }
    const expiresIn = Number(data.expires_in ?? 7200)
    this.accessToken = data.access_token
    this.tokenExpiresAt = now + expiresIn * 1000
    return this.accessToken
  }

  /** Build the standard authorization headers for REST calls. */
  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.getAccessToken()
    return {
      Authorization: `QQBot ${token}`,
      'X-Union-Appid': this.appId,
      'Content-Type': 'application/json',
    }
  }

  // ── Send ───────────────────────────────────────────────────────────────────

  @Span('QQChannel.send')
  async send(msg: OutboundMessage): Promise<string | null> {
    this.assertConnection()
    const target = parseChatId(msg.chatId)
    if (!target) {
      throw new QQDeliveryError('invalid_source', 'rejected')
    }

    const isV2 = target.kind === 'group' || target.kind === 'c2c'
    const passiveMsgId = isV2 ? msg.replyTo : msg.replyTo ?? this._lastMsgId.get(msg.chatId)
    const deliver = async (next?: () => number) => {
      let firstMessageId: string | null = null
      if (msg.content.trim()) {
        firstMessageId = await this.sendText(
          target,
          msg.content,
          passiveMsgId,
          next,
        )
      }

      if (msg.media && msg.media.length > 0) {
        for (const mediaPath of msg.media) {
          const id = await this.sendMedia(target, msg.chatId, mediaPath, passiveMsgId, next).catch(error => {
            if (isV2) throw error
            console.warn('[qq] Failed to send guild media')
            return null
          })
          firstMessageId ??= id
        }
      }
      return firstMessageId
    }
    if (isV2) {
      const count = Number(!!msg.content.trim()) + (msg.media?.length ?? 0)
      if (!count) return null
      // Session handoffs have no QQ source: send a proactive group notification.
      // An explicit passive source never falls back after rejection or expiry.
      if (target.kind === 'group' && passiveMsgId === undefined) return deliver()
      return this.passiveReplies.send(msg.chatId, passiveMsgId, count, deliver)
    }
    // Retain legacy guild failure/fallback behavior.
    try { return await deliver() } catch {
      console.error('[qq] Error sending guild message')
      return null
    }
  }

  private async sendText(
    target: QQTarget,
    content: string,
    passiveMsgId: string | undefined,
    next?: () => number,
  ): Promise<string | null> {
    const headers = await this.authHeaders()
    const path = target.kind === 'group'
      ? `/v2/groups/${target.id}/messages`
      : target.kind === 'c2c'
      ? `/v2/users/${target.id}/messages`
      : target.kind === 'channel'
      ? `/channels/${target.id}/messages`
      : `/dms/${target.id}/messages`
    const isV2 = target.kind === 'group' || target.kind === 'c2c'

    // V2 sends exactly one format; only guilds retain their legacy fallback.
    if (this.markdown) {
      const mdBody: Record<string, unknown> = { markdown: { content } }
      if (isV2) {
        mdBody.msg_type = MSG_TYPE_MARKDOWN
        if (next) mdBody.msg_seq = next()
      }
      if (passiveMsgId) mdBody.msg_id = passiveMsgId

      try {
        return await this.postMessage(path, headers, mdBody)
      } catch (error) {
        // No documented safe V2 formatting-only rejection is allowlisted.
        // Never turn a quota, permission or ambiguous failure into a second send.
        if (isV2 || (error instanceof QQDeliveryError && error.status === undefined)) throw error
        console.warn('[qq] Guild Markdown send rejected, falling back to plain text')
      }
    }

    const body: Record<string, unknown> = { content }
    if (isV2) {
      body.msg_type = MSG_TYPE_TEXT
      if (next) body.msg_seq = next()
    }
    if (passiveMsgId) body.msg_id = passiveMsgId
    return this.postMessage(path, headers, body)
  }

  private async postMessage(
    path: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<string> {
    let res: Response
    try {
      res = await this.request(`${this.apiBase}${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      })
    } catch {
      throw new QQDeliveryError('unknown', 'unknown')
    }
    if (!res.ok) {
      throw await qqResponseError(res)
    }
    const data: unknown = await res.json().catch(() => undefined)
    if (!data || typeof data !== 'object' || !('id' in data) || typeof data.id !== 'string' || !data.id) {
      throw new QQDeliveryError('unknown', 'unknown', res.status)
    }
    return data.id
  }

  /**
   * Send a media attachment.
   *
   * Group / C2C: upload rich media to obtain a `file_info`, then send a
   * media message (msg_type 7). Guild channels: send via multipart form.
   */
  private async sendMedia(
    target: QQTarget,
    chatId: string,
    mediaPath: string,
    passiveMsgId: string | undefined,
    next?: () => number,
  ): Promise<string | null> {
    const { filename, data, ext } = await readMediaFile(
      this.workspace,
      this.logicalSessionId(chatId),
      mediaPath,
    )

    if (target.kind === 'group' || target.kind === 'c2c') {
      const fileType = mediaFileType(ext)
      const headers = await this.authHeaders()
      const uploaded = await this.uploadNamedMedia(
        target,
        headers,
        filename,
        data,
        fileType,
      )
      if (typeof uploaded.file_info !== 'string' || !uploaded.file_info) {
        throw new Error('QQ media upload response missing file_info')
      }

      const sendPath = target.kind === 'group'
        ? `/v2/groups/${target.id}/messages`
        : `/v2/users/${target.id}/messages`
      const body: Record<string, unknown> = {
        msg_type: MSG_TYPE_MEDIA,
        media: { file_info: uploaded.file_info },
      }
      if (next) body.msg_seq = next()
      if (passiveMsgId) body.msg_id = passiveMsgId
      return this.postMessage(sendPath, headers, body)
    }

    // Guild channel / direct message: multipart upload
    const token = await this.getAccessToken()
    const sendPath = target.kind === 'channel'
      ? `/channels/${target.id}/messages`
      : `/dms/${target.id}/messages`
    const form = new FormData()
    if (passiveMsgId) form.append('msg_id', passiveMsgId)
    const copy = new Uint8Array(data.byteLength)
    copy.set(data)
    form.append('file_image', new Blob([copy]), filename)
    const res = await this.request(`${this.apiBase}${sendPath}`, {
      method: 'POST',
      headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': this.appId },
      body: form,
    })
    if (!res.ok) {
      await res.body?.cancel()
      console.warn(
        `[qq] Guild media send failed: status=${res.status}`,
      )
    }
    return null
  }

  /**
   * Upload media through QQ's multipart protocol. Unlike `file_data`, the
   * prepare request carries `file_name`, so QQ preserves the download name.
   */
  private async uploadNamedMedia(
    target: Extract<QQTarget, { kind: 'group' | 'c2c' }>,
    headers: Record<string, string>,
    filename: string,
    data: Uint8Array,
    fileType: number,
  ): Promise<{ file_info?: string }> {
    const resourcePath = target.kind === 'group'
      ? `/v2/groups/${target.id}`
      : `/v2/users/${target.id}`
    const preparePath = `${resourcePath}/upload_prepare`
    const digest = (algorithm: 'md5' | 'sha1', bytes: Uint8Array): string =>
      createHash(algorithm).update(bytes).digest('hex')

    const prepareRes = await this.request(`${this.apiBase}${preparePath}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        file_type: fileType,
        file_name: filename,
        file_size: data.byteLength,
        md5: digest('md5', data),
        sha1: digest('sha1', data),
        md5_10m: digest('md5', data.subarray(0, 10 * 1024 * 1024)),
      }),
    })
    if (!prepareRes.ok) {
      throw await qqResponseError(prepareRes)
    }

    const prepared = await prepareRes.json().catch(() => {
      throw new Error('QQ media upload preparation returned invalid JSON')
    }) as {
      upload_id?: string
      block_size?: number
      parts?: Array<{ index?: number; presigned_url?: string }>
    }
    if (
      !prepared.upload_id || !prepared.block_size || !prepared.parts?.length
    ) {
      throw new Error(
        'Media upload preparation response is missing upload parts',
      )
    }

    for (let offset = 0; offset < prepared.parts.length; offset++) {
      const part = prepared.parts[offset]
      if (part.index === undefined || !part.presigned_url) {
        throw new Error('Media upload preparation response has an invalid part')
      }
      const bytes = data.subarray(
        offset * prepared.block_size,
        (offset + 1) * prepared.block_size,
      )
      const uploadBytes = new Uint8Array(new ArrayBuffer(bytes.byteLength))
      uploadBytes.set(bytes)
      const putRes = await this.request(part.presigned_url, {
        method: 'PUT',
        body: uploadBytes,
      })
      if (!putRes.ok) {
        throw new Error(`Media part upload failed: status=${putRes.status}`)
      }

      const finishPath = `${resourcePath}/upload_part_finish`
      const finishRes = await this.request(`${this.apiBase}${finishPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          upload_id: prepared.upload_id,
          part_index: part.index,
          block_size: bytes.byteLength,
          md5: digest('md5', bytes),
        }),
      })
      if (!finishRes.ok) {
        throw await qqResponseError(finishRes)
      }
    }

    const uploadRes = await this.request(`${this.apiBase}${resourcePath}/files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ upload_id: prepared.upload_id }),
    })
    if (!uploadRes.ok) {
      throw await qqResponseError(uploadRes)
    }
    return await uploadRes.json().catch(() => {
      throw new Error('QQ media upload completion returned invalid JSON')
    }) as { file_info?: string }
  }

  // ── WebSocket gateway ──────────────────────────────────────────────────────

  private async getGatewayUrl(): Promise<string> {
    const headers = await this.authHeaders()
    const res = await this.request(`${this.apiBase}/gateway`, {
      headers, signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`QQ gateway request failed: status=${res.status}`)
    }
    const data = await res.json() as { url?: string }
    if (!data.url) throw new Error('gateway response missing url')
    return data.url
  }

  private async connect(): Promise<void> {
    if (this.stopping) return
    const controller = this.controller
    this.setAccepting(true)
    this.reportState('connecting')
    try {
      this.gatewayUrl = await this.getGatewayUrl()
    } catch {
      if (this.stopping || this.controller !== controller) return
      this.reportState('error')
      console.error('[qq] Failed to fetch gateway URL')
      this.scheduleReconnect()
      return
    }

    if (this.stopping || this.controller !== controller) return
    const ws = new WebSocket(this.gatewayUrl)
    ws.binaryType = 'arraybuffer'
    this.ws = ws

    this.ws.onopen = this.bindCallback(() => console.debug('[qq] WebSocket connected'))

    this.ws.onmessage = this.bindCallback((event: MessageEvent) => {
      if (this.stopping || this.ws !== ws) return
      let data: QQGatewayPayload
      try {
        data = decodeQQGatewayPayload(event.data)
      } catch {
        console.warn('[qq] Gateway frame rejected: invalid encoding or payload')
        return
      }

      if (typeof data.s === 'number') this.seq = data.s

      switch (data.op) {
        case OP_HELLO:
          this.startHeartbeat(
            (data.d as Record<string, number>)?.heartbeat_interval ?? 30_000,
          )
          if (this.sessionId) this.resume()
          else this.identify()
          break
        case OP_HEARTBEAT_ACK:
          this.heartbeatAcknowledged = true
          break
        case OP_RECONNECT:
          console.info('[qq] Gateway requested reconnect')
          this.ws?.close()
          break
        case OP_INVALID_SESSION:
          console.warn('[qq] Invalid session, re-identifying')
          this.sessionId = null
          this.seq = null
          this.reportState('connecting')
          clearTimeout(this.identifyTimer)
          this.identifyTimer = setTimeout(() => {
            if (!this.stopping && this.ws === ws) void this.identify()
          }, 2000)
          break
        case OP_DISPATCH:
          this.withConnection(() => this.handleDispatch(data.t ?? '', data.d ?? {})).catch((err) =>
            console.error('[qq] Incoming message handling failed')
          )
          break
      }
    })

    this.ws.onclose = this.bindCallback((event: CloseEvent) => {
      if (this.stopping || this.ws !== ws) return
      this.ws = null
      this.setAccepting(false)
      this.reportState('disconnected')
      clearTimeout(this.identifyTimer)
      console.warn(
        `[qq] WebSocket closed: code=${event.code}`,
      )
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      if ([4004, 4010, 4011, 4013, 4014].includes(event.code)) {
        this.reportState('error')
        return
      }
      if (!this.stopping) this.scheduleReconnect()
    })

    this.ws.onerror = this.bindCallback(() => {
      if (this.stopping || this.ws !== ws) return
      this.reportState('error')
      console.error('[qq] WebSocket error')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return
    console.info('[qq] Reconnecting in 5s...')
    this.reconnectTimer = setTimeout(
      () => {
        this.reconnectTimer = undefined
        if (this.stopping) return
        void this.connect().catch(() => {
          if (this.stopping) return
          this.reportState('error')
          console.error('[qq] Reconnect failed')
          this.scheduleReconnect()
        })
      },
      5000,
    )
  }

  private async identify(): Promise<void> {
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const ws = this.ws
      const token = await this.getAccessToken()
      if (this.stopping || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({
        op: OP_IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          shard: [0, 1],
          properties: {},
        },
      }))
    } catch {
      if (this.stopping) return
      this.reportState('error')
      console.warn('[qq] Identify send failed')
    }
  }

  private async resume(): Promise<void> {
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const ws = this.ws
      const token = await this.getAccessToken()
      if (this.stopping || this.ws !== ws || ws.readyState !== WebSocket.OPEN) return
      ws.send(JSON.stringify({
        op: OP_RESUME,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.seq,
        },
      }))
    } catch {
      if (this.stopping) return
      this.reportState('error')
      console.warn('[qq] Resume send failed')
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatAcknowledged = true
    if (!Number.isFinite(intervalMs) || intervalMs < 100 || intervalMs > 300_000) {
      this.reportState('error')
      this.ws?.close()
      return
    }
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.ws?.readyState === WebSocket.OPEN) {
          if (!this.heartbeatAcknowledged) {
            this.reportState('disconnected')
            this.ws.close()
            return
          }
          this.heartbeatAcknowledged = false
          this.ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.seq }))
        }
      } catch (err) {
        this.reportState('error')
        console.warn('[qq] Heartbeat send failed')
      }
    }, intervalMs)
  }

  // ── Dispatch handling ──────────────────────────────────────────────────────

  private async handleDispatch(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (event === 'READY') {
      this.reportState('connected')
      this.sessionId = (data.session_id as string) ?? null
      const user = data.user as Record<string, string> | undefined
      this.botUserId = typeof user?.id === 'string' ? user.id : null
      console.info(
        `[qq] Ready: sessionId=${this.sessionId}, bot=${
          user?.username ?? this.appId
        }`,
      )
      return
    }
    if (event === 'RESUMED') {
      this.reportState('connected')
      console.info('[qq] Session resumed')
      return
    }

    // Log wire shape only: message bodies, sender IDs and signed URLs stay private.
    console.info('[qq] Gateway dispatch', {
      event: /^[A-Z_]{1,64}$/.test(event) ? event : 'unknown',
      ...qqInboundDiagnostics(data),
    })

    switch (event) {
      case 'GROUP_MESSAGE_CREATE':
      case 'GROUP_AT_MESSAGE_CREATE':
        await this.onGroupMessage(data, event === 'GROUP_AT_MESSAGE_CREATE')
        break
      case 'C2C_MESSAGE_CREATE':
        await this.onC2CMessage(data)
        break
      case 'AT_MESSAGE_CREATE':
        await this.onGuildMessage(data, false)
        break
      case 'DIRECT_MESSAGE_CREATE':
        await this.onGuildMessage(data, true)
        break
    }
  }

  private async onGroupMessage(data: Record<string, unknown>, mentioned: boolean): Promise<void> {
    const msgId = data.id as string | undefined
    const groupId = data.group_openid as string | undefined
    const author = data.author as Record<string, string> | undefined
    const senderId = author?.member_openid
    if (!msgId || !groupId || !senderId) return
    if (!this.isAllowed(senderId)) throw new ChannelAdmissionError('[qq] Sender is not authorized', 403)
    const chatId = `group:${groupId}`
    if (!this.isNewIncoming(chatId, msgId, data)) return

    const { content, media, displayMetadata } = await this.downloadAttachments(data, chatId, ((data.content as string) ?? '').trim())
    if (!content && !media) return

    const mentionsBot = mentioned || (Array.isArray(data.mentions) && data.mentions.some(
      (mention: unknown) => mention !== null && typeof mention === 'object'
        && (('is_you' in mention && mention.is_you === true)
          || ('id' in mention && typeof mention.id === 'string'
            && (mention.id === this.botUserId || mention.id === this.appId))),
    ))
    await this.passiveReplies.admit(chatId, msgId, data.timestamp, () => this.handleIncoming(senderId, chatId, content, msgId, {
      platformMessageId: msgId,
      isGroup: true,
      ...(typeof author?.username === 'string' ? { senderName: author.username } : {}),
      displayMetadata,
      silent: this.triggerMode === 'mention' && !mentionsBot,
    }, media))
    this.rememberIncoming(chatId, data, content, media, displayMetadata)
  }

  private async onC2CMessage(data: Record<string, unknown>): Promise<void> {
    const msgId = data.id as string | undefined
    const author = data.author as Record<string, string> | undefined
    const senderId = author?.user_openid
    if (!msgId || !senderId) return
    if (!this.isAllowed(senderId)) throw new ChannelAdmissionError('[qq] Sender is not authorized', 403)
    const chatId = `c2c:${senderId}`
    if (!this.isNewIncoming(chatId, msgId, data)) return

    const { content, media, displayMetadata } = await this.downloadAttachments(data, chatId, ((data.content as string) ?? '').trim())
    if (!content && !media) return

    await this.passiveReplies.admit(chatId, msgId, data.timestamp, () => this.handleIncoming(senderId, chatId, content, msgId, {
      platformMessageId: msgId,
      isGroup: false,
      ...(typeof author?.username === 'string' ? { senderName: author.username } : {}),
      displayMetadata,
    }, media))
    this.rememberIncoming(chatId, data, content, media, displayMetadata)
  }

  private async onGuildMessage(
    data: Record<string, unknown>,
    isDirect: boolean,
  ): Promise<void> {
    const msgId = data.id as string | undefined
    const author = data.author as Record<string, string> | undefined
    const senderId = author?.id
    if (!msgId || !senderId) return
    if (!this.isAllowed(senderId)) throw new ChannelAdmissionError('[qq] Sender is not authorized', 403)
    const chatId = isDirect
      ? `dms:${data.guild_id as string}`
      : `channel:${data.channel_id as string}`
    if (!this.isNewIncoming(chatId, msgId, data)) return
    this._lastMsgId.set(chatId, msgId)

    const member = data.member as Record<string, unknown> | undefined
    const senderName = (member?.nick as string) ?? author?.username ?? senderId

    const { content, media, displayMetadata } = await this.downloadAttachments(data, chatId, stripGuildMention((data.content as string) ?? '').trim())
    if (!content && !media) return

    await this.handleIncoming(senderId, chatId, content, msgId, {
      platformMessageId: msgId,
      isGroup: !isDirect,
      senderName,
      displayMetadata,
    }, media)
    this.rememberIncoming(chatId, data, content, media, displayMetadata)
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  private isNewIncoming(chatId: string, msgId: string, data: Record<string, unknown>): boolean {
    const { messageIndex } = qqMessageIndices(data)
    return this._seenIds.add(JSON.stringify([chatId, messageIndex ? 'index' : 'id', messageIndex ?? msgId]))
  }

  private rememberIncoming(chatId: string, data: Record<string, unknown>, content: string, media?: string[], metadata?: ChannelMessageMetadata): void {
    if (this.stopping) return
    const { messageIndex, invalid } = qqMessageIndices(data)
    if (invalid) return
    const index = messageIndex ?? (typeof data.id === 'string' ? data.id : undefined)
    if (index) {
      this.assertConnection()
      this.references.remember(chatId, index, { content, media: media ?? [], attachments: metadata?.attachments })
    }
  }

  /**
   * Download any inbound attachments and cache them under the session uploads
   * dir. Keep failures in the message so attachment-only input is not lost.
   */
  private async downloadAttachments(
    data: Record<string, unknown>,
    chatId: string,
    content: string,
  ): Promise<{ content: string; media?: string[]; displayMetadata?: ChannelMessageMetadata }> {
    const { referenceIndex } = qqMessageIndices(data)
    const reference = referenceIndex ? this.references.get(chatId, referenceIndex) : undefined
    const incoming = qqIncomingContent(data, content, reference, index => this.references.get(chatId, index))
    if (referenceIndex) console.info('[qq] Reference lookup', { cached: !!reference, usedCachedMedia: incoming.cachedMedia.length })
    const { attachments } = incoming
    content = incoming.content
    if (incoming.notices.length) console.warn('[qq] Incomplete attachment or quoted message data')
    const assertActive = this.connectionGuard()
    const sessionId = this.logicalSessionId(chatId)
    const results: string[] = [...incoming.cachedMedia]
    const displayMetadata: ChannelMessageMetadata = { ...incoming.displayMetadata }
    const attachmentMetadata: NonNullable<ChannelMessageMetadata['attachments']> = [...displayMetadata.attachments ?? []]
    let downloadedCount = 0
    const notices: string[] = [...incoming.notices]
    for (const att of attachments) {
      assertActive()
      try {
        const sources = qqAttachmentSources(att)
        let downloaded: { url: URL; bytes: Uint8Array; filename?: string; contentType?: string; httpType?: string } | undefined
        for (const [index, source] of sources.entries()) {
          try {
            // QQ media URLs sometimes omit the scheme or use a protocol-relative URL.
            const rawUrl = source.url.trim()
            const url = new URL(rawUrl.startsWith('//') ? `https:${rawUrl}`
              : /^[a-z][a-z\d+.-]*:/i.test(rawUrl) ? rawUrl : `https://${rawUrl}`)
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Invalid attachment URL')
            const res = await this.request(url)
            if (!res.ok) {
              await res.body?.cancel()
              console.warn(`[qq] Failed to download attachment: ${res.status}`)
              throw new Error('Attachment download failed')
            }
            downloaded = { url, bytes: new Uint8Array(await res.arrayBuffer()),
              filename: source.filename, contentType: source.contentType, httpType: res.headers.get('content-type') ?? undefined }
            break
          } catch {
            assertActive()
            if (index === sources.length - 1) throw new Error('Attachment download failed')
            console.warn('[qq] Converted voice download failed; trying the original attachment')
          }
        }
        if (!downloaded) throw new Error('No attachment URL')
        const { url, bytes: buf } = downloaded
        const urlName = decodeURIComponent(url.pathname.split('/').at(-1) ?? '')
        const rawName = downloaded.filename?.trim() ? downloaded.filename : urlName || 'attachment'
        const safeName = rawName.split(/[\\/]/).at(-1)!.normalize('NFC')
          .replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/^\.+|\.+$/g, '').slice(-60) || 'attachment'
        const ext = extname(safeName) || guessExt(downloaded.contentType) || guessExt(downloaded.httpType)
        const saveName = `qq_${randomUUID()}_${safeName}${extname(safeName) ? '' : ext}`
        assertActive()
        this.assertConnection()
        const rel = await saveToUploads(
          this.workspace,
          sessionId,
          saveName,
          buf,
        )
        results.push(rel)
        downloadedCount++
        const metadata: NonNullable<ChannelMessageMetadata['attachments']>[number] = { path: rel }
        if (att.shadowSticker === true) metadata.sticker = true
        if (typeof att.content_type === 'string') metadata.contentType = att.content_type
        for (const key of ['size', 'width', 'height'] as const) {
          if (typeof att[key] === 'number' && Number.isSafeInteger(att[key]) && att[key] >= 0) metadata[key] = att[key]
        }
        if (Object.keys(metadata).length > 1) attachmentMetadata.push(metadata)
      } catch {
        assertActive()
        // Signed CDN URLs and response bodies must not enter logs or prompts.
        console.warn('[qq] Error downloading attachment')
        notices.push('[attachment unavailable: download failed]')
      }
    }
    if (attachments.length) {
      console.info('[qq] Attachment reception', { received: attachments.length, saved: downloadedCount, failed: attachments.length - downloadedCount })
    }
    if (attachmentMetadata.length) displayMetadata.attachments = attachmentMetadata
    return { content: [content, ...notices].filter(Boolean).join('\n'), media: results.length ? results : undefined,
      ...(Object.keys(displayMetadata).length ? { displayMetadata } : {}) }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map a file extension to the QQ group/C2C rich-media file_type code. */
function mediaFileType(ext: string): number {
  const e = ext.toLowerCase()
  if (IMAGE_EXTS.has(e)) return FILE_TYPE_IMAGE
  if (VIDEO_EXTS.has(e)) return FILE_TYPE_VIDEO
  if (AUDIO_EXTS.has(e)) return FILE_TYPE_AUDIO
  return FILE_TYPE_FILE
}

/** Guess a file extension from a MIME type. */
function guessExt(contentType: string | undefined): string {
  if (!contentType) return ''
  const map: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'video/mp4': '.mp4',
    'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg',
    'audio/wav': '.wav',
    'audio/silk': '.silk',
    'voice': '.silk',
    'application/pdf': '.pdf',
    'text/plain': '.txt',
    'text/csv': '.csv',
    'application/json': '.json',
    'application/zip': '.zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  }
  return map[contentType.split(';')[0].trim().toLowerCase()] ?? ''
}

/** Strip `<@!123>` style mention markup from guild channel message text. */
function stripGuildMention(text: string): string {
  return text.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim()
}
