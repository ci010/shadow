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
import { createHash } from 'node:crypto'
import type { Hono } from 'hono'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import { Span } from '../utils/otel.ts'
import { readMediaFile, saveToUploads } from '../utils/paths.ts'
import { RingSet } from '../utils/ring-set.ts'
import { errMsg } from '../utils/truncate.ts'
import { AbstractChannel } from './base.ts'

// ---------------------------------------------------------------------------
// Endpoints & constants
// ---------------------------------------------------------------------------

const TOKEN_URL = 'https://bots.qq.com/app/getAppAccessToken'
const API_BASE = 'https://api.sgroup.qq.com'
const SANDBOX_API_BASE = 'https://sandbox.api.sgroup.qq.com'

// Gateway intents (bitmask). See https://bot.q.qq.com/wiki/develop/api-v2/dev-prepare/interface-framework/event-emit.html
const INTENT_GUILDS = 1 << 0
const INTENT_PUBLIC_GUILD_MESSAGES = 1 << 30 // AT_MESSAGE_CREATE
const INTENT_GROUP_AND_C2C_EVENT = 1 << 25 // GROUP_AT_MESSAGE_CREATE | C2C_MESSAGE_CREATE
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
  allowFrom?: string[]
  /** Workspace root path — downloaded attachments are cached under <workspace>/uploads/ */
  workspace?: string
  /** Group / channel IDs that have admin privileges. DMs are admin by default. */
  adminChats?: string[]
}

// ---------------------------------------------------------------------------
// QQChannel
// ---------------------------------------------------------------------------

export class QQChannel extends AbstractChannel {
  readonly name = 'qq'

  // QQ group/C2C messages cannot be edited, so opt out of progressive updates:
  // the base class sends each outbound chunk as an independent message.
  override update = undefined

  private appId: string
  private secret: string
  private botToken: string
  private apiBase: string
  private intents: number
  private markdown: boolean
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
  private botAppId: string | null = null

  // Dedup recently seen message IDs (gateway may redeliver)
  private _seenIds = new RingSet<string>(200)

  // Last inbound message id per chat — used as the passive-reply target so the
  // bot can answer within the platform's reply window even for follow-up sends.
  private _lastMsgId = new Map<string, string>()

  // Per-source-message reply sequence counter (QQ requires a unique msg_seq for
  // each passive reply to the same msg_id).
  private _msgSeq = new Map<string, number>()

  constructor(bus: Bus, opts: QQChannelOptions) {
    super(bus, opts.allowFrom, false, opts.adminChats)
    this.appId = opts.appId
    this.secret = opts.secret
    this.botToken = opts.token ?? ''
    this.apiBase = opts.sandbox ? SANDBOX_API_BASE : API_BASE
    this.intents = opts.intents ?? DEFAULT_INTENTS
    this.markdown = opts.markdown ?? true
    this.workspace = opts.workspace ?? '.'
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @Span('QQChannel.start')
  async start(_app: Hono): Promise<void> {
    if (!this.appId || !this.secret) {
      console.warn('[qq] appId and secret are required; skipping')
      return
    }
    this.stopping = false
    this.botAppId = this.appId

    console.info('[qq] Connecting to QQ Bot gateway...')
    await this.connect()
  }

  @Span('QQChannel.stop')
  stop(): Promise<void> {
    this.stopping = true
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = null
    }
    try {
      this.ws?.close()
    } catch {
      // ignore
    }
    this.ws = null
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

    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appId: this.appId, clientSecret: this.secret }),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`token request failed: status=${res.status} ${text}`)
    }
    const data = await res.json() as {
      access_token?: string
      expires_in?: number | string
      message?: string
    }
    if (!data.access_token) {
      throw new Error(
        `token response missing access_token: ${data.message ?? ''}`,
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
    const target = parseChatId(msg.chatId)
    if (!target) {
      console.warn(`[qq] Unrecognized chatId format: ${msg.chatId}`)
      return null
    }

    let firstMessageId: string | null = null
    try {
      const passiveMsgId = msg.replyTo ?? this._lastMsgId.get(msg.chatId)

      if (msg.content.trim()) {
        firstMessageId = await this.sendText(
          target,
          msg.content,
          passiveMsgId,
        )
      }

      if (msg.media && msg.media.length > 0) {
        for (const mediaPath of msg.media) {
          await this.sendMedia(target, msg.chatId, mediaPath, passiveMsgId)
            .catch((err) =>
              console.warn(
                `[qq] Failed to send media ${mediaPath}`,
                errMsg(err),
              )
            )
        }
      }
    } catch (err) {
      console.error('[qq] Error sending message', errMsg(err))
    }
    return firstMessageId
  }

  /** Next msg_seq for a given passive source message id. */
  private nextSeq(passiveMsgId: string | undefined): number {
    if (!passiveMsgId) return 1
    const next = (this._msgSeq.get(passiveMsgId) ?? 0) + 1
    this._msgSeq.set(passiveMsgId, next)
    // Bound the map so it doesn't grow without limit
    if (this._msgSeq.size > 500) {
      const firstKey = this._msgSeq.keys().next().value
      if (firstKey !== undefined) this._msgSeq.delete(firstKey)
    }
    return next
  }

  private async sendText(
    target: QQTarget,
    content: string,
    passiveMsgId: string | undefined,
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

    // Try Markdown first (msg_type 2). QQ Markdown can reject content that the
    // plain-text endpoint accepts (e.g. links to unconfigured domains), so fall
    // back to a plain-text send when the Markdown payload is rejected.
    if (this.markdown) {
      const mdBody: Record<string, unknown> = { markdown: { content } }
      if (isV2) {
        mdBody.msg_type = MSG_TYPE_MARKDOWN
        mdBody.msg_seq = this.nextSeq(passiveMsgId)
      }
      if (passiveMsgId) mdBody.msg_id = passiveMsgId

      const md = await this.postMessage(path, headers, mdBody)
      if (md.ok) return md.id
      console.warn('[qq] Markdown send rejected, falling back to plain text')
    }

    const body: Record<string, unknown> = { content }
    if (isV2) {
      body.msg_type = MSG_TYPE_TEXT
      body.msg_seq = this.nextSeq(passiveMsgId)
    }
    if (passiveMsgId) body.msg_id = passiveMsgId
    const res = await this.postMessage(path, headers, body)
    return res.id
  }

  private async postMessage(
    path: string,
    headers: Record<string, string>,
    body: Record<string, unknown>,
  ): Promise<{ ok: boolean; id: string | null }> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`[qq] Send failed (${path}): status=${res.status} ${text}`)
      return { ok: false, id: null }
    }
    const data = await res.json().catch(() => ({})) as { id?: string }
    return { ok: true, id: data.id ?? null }
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
  ): Promise<void> {
    const { filename, data, ext } = await readMediaFile(
      this.workspace,
      `${this.name}:${chatId}`,
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
      if (!uploaded.file_info) {
        console.warn('[qq] Media upload response missing file_info')
        return
      }

      const sendPath = target.kind === 'group'
        ? `/v2/groups/${target.id}/messages`
        : `/v2/users/${target.id}/messages`
      const body: Record<string, unknown> = {
        msg_type: MSG_TYPE_MEDIA,
        msg_seq: this.nextSeq(passiveMsgId),
        media: { file_info: uploaded.file_info },
      }
      if (passiveMsgId) body.msg_id = passiveMsgId
      await this.postMessage(sendPath, headers, body)
      return
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
    const res = await fetch(`${this.apiBase}${sendPath}`, {
      method: 'POST',
      headers: { Authorization: `QQBot ${token}`, 'X-Union-Appid': this.appId },
      body: form,
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(
        `[qq] Guild media send failed (${sendPath}): status=${res.status} ${text}`,
      )
    }
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

    const prepareRes = await fetch(`${this.apiBase}${preparePath}`, {
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
      const text = await prepareRes.text().catch(() => '')
      throw new Error(
        `Media upload preparation failed (${preparePath}): status=${prepareRes.status} ${text}`,
      )
    }

    const prepared = await prepareRes.json() as {
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
      const putRes = await fetch(part.presigned_url, {
        method: 'PUT',
        body: uploadBytes,
      })
      if (!putRes.ok) {
        throw new Error(`Media part upload failed: status=${putRes.status}`)
      }

      const finishPath = `${resourcePath}/upload_part_finish`
      const finishRes = await fetch(`${this.apiBase}${finishPath}`, {
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
        const text = await finishRes.text().catch(() => '')
        throw new Error(
          `Media part completion failed (${finishPath}): status=${finishRes.status} ${text}`,
        )
      }
    }

    const uploadRes = await fetch(`${this.apiBase}${resourcePath}/files`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ upload_id: prepared.upload_id }),
    })
    if (!uploadRes.ok) {
      const text = await uploadRes.text().catch(() => '')
      throw new Error(
        `Media upload completion failed (${resourcePath}/files): status=${uploadRes.status} ${text}`,
      )
    }
    return await uploadRes.json() as { file_info?: string }
  }

  // ── WebSocket gateway ──────────────────────────────────────────────────────

  @Span('QQChannel.getGatewayUrl')
  private async getGatewayUrl(): Promise<string> {
    const headers = await this.authHeaders()
    const res = await fetch(`${this.apiBase}/gateway`, { headers })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`gateway request failed: status=${res.status} ${text}`)
    }
    const data = await res.json() as { url?: string }
    if (!data.url) throw new Error('gateway response missing url')
    return data.url
  }

  private async connect(): Promise<void> {
    try {
      this.gatewayUrl = await this.getGatewayUrl()
    } catch (err) {
      console.error('[qq] Failed to fetch gateway URL', errMsg(err))
      this.scheduleReconnect()
      return
    }

    console.debug(`[qq] Connecting to gateway: ${this.gatewayUrl}`)
    this.ws = new WebSocket(this.gatewayUrl)

    this.ws.onopen = () => console.debug('[qq] WebSocket connected')

    this.ws.onmessage = (event: MessageEvent) => {
      let data: {
        op: number
        d: Record<string, unknown> | null
        s: number | null
        t: string | null
      }
      try {
        data = JSON.parse(String(event.data))
      } catch {
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
          break
        case OP_RECONNECT:
          console.info('[qq] Gateway requested reconnect')
          this.ws?.close()
          break
        case OP_INVALID_SESSION:
          console.warn('[qq] Invalid session, re-identifying')
          this.sessionId = null
          this.seq = null
          setTimeout(() => this.identify(), 2000)
          break
        case OP_DISPATCH:
          this.handleDispatch(data.t ?? '', data.d ?? {}).catch((err) =>
            console.error('[qq] Error in handleDispatch', errMsg(err))
          )
          break
      }
    }

    this.ws.onclose = (event: CloseEvent) => {
      console.warn(
        `[qq] WebSocket closed: code=${event.code}, reason=${event.reason}`,
      )
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      if (!this.stopping) this.scheduleReconnect()
    }

    this.ws.onerror = (event: Event) => {
      console.error(
        '[qq] WebSocket error',
        (event as ErrorEvent)?.message ?? event,
      )
    }
  }

  private scheduleReconnect(): void {
    if (this.stopping) return
    console.info('[qq] Reconnecting in 5s...')
    setTimeout(
      () =>
        this.connect().catch((err) =>
          console.error('[qq] Reconnect failed', errMsg(err))
        ),
      5000,
    )
  }

  private async identify(): Promise<void> {
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const token = await this.getAccessToken()
      this.ws.send(JSON.stringify({
        op: OP_IDENTIFY,
        d: {
          token: `QQBot ${token}`,
          intents: this.intents,
          shard: [0, 1],
          properties: {},
        },
      }))
    } catch (err) {
      console.warn('[qq] Identify send failed', errMsg(err))
    }
  }

  private async resume(): Promise<void> {
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      const token = await this.getAccessToken()
      this.ws.send(JSON.stringify({
        op: OP_RESUME,
        d: {
          token: `QQBot ${token}`,
          session_id: this.sessionId,
          seq: this.seq,
        },
      }))
    } catch (err) {
      console.warn('[qq] Resume send failed', errMsg(err))
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: OP_HEARTBEAT, d: this.seq }))
        }
      } catch (err) {
        console.warn('[qq] Heartbeat send failed', errMsg(err))
      }
    }, intervalMs)
  }

  // ── Dispatch handling ──────────────────────────────────────────────────────

  private async handleDispatch(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (event === 'READY') {
      this.sessionId = (data.session_id as string) ?? null
      const user = data.user as Record<string, string> | undefined
      console.info(
        `[qq] Ready: sessionId=${this.sessionId}, bot=${
          user?.username ?? this.appId
        }`,
      )
      return
    }
    if (event === 'RESUMED') {
      console.info('[qq] Session resumed')
      return
    }

    switch (event) {
      case 'GROUP_AT_MESSAGE_CREATE':
        await this.onGroupMessage(data)
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

  private async onGroupMessage(data: Record<string, unknown>): Promise<void> {
    const msgId = data.id as string | undefined
    const groupId = data.group_openid as string | undefined
    const author = data.author as Record<string, string> | undefined
    const senderId = author?.member_openid
    if (!msgId || !groupId || !senderId) return
    if (!this._seenIds.add(msgId)) return

    const chatId = `group:${groupId}`
    this._lastMsgId.set(chatId, msgId)

    const content = ((data.content as string) ?? '').trim()
    const media = await this.downloadAttachments(data, chatId)
    if (!content && !media) return

    await this.handleIncoming(senderId, chatId, content, msgId, {
      platformMessageId: msgId,
      isGroup: true,
    }, media)
  }

  private async onC2CMessage(data: Record<string, unknown>): Promise<void> {
    const msgId = data.id as string | undefined
    const author = data.author as Record<string, string> | undefined
    const senderId = author?.user_openid
    if (!msgId || !senderId) return
    if (!this._seenIds.add(msgId)) return

    const chatId = `c2c:${senderId}`
    this._lastMsgId.set(chatId, msgId)

    const content = ((data.content as string) ?? '').trim()
    const media = await this.downloadAttachments(data, chatId)
    if (!content && !media) return

    await this.handleIncoming(senderId, chatId, content, msgId, {
      platformMessageId: msgId,
      isGroup: false,
    }, media)
  }

  private async onGuildMessage(
    data: Record<string, unknown>,
    isDirect: boolean,
  ): Promise<void> {
    const msgId = data.id as string | undefined
    const author = data.author as Record<string, string> | undefined
    const senderId = author?.id
    if (!msgId || !senderId) return
    if (!this._seenIds.add(msgId)) return

    const chatId = isDirect
      ? `dms:${data.guild_id as string}`
      : `channel:${data.channel_id as string}`
    this._lastMsgId.set(chatId, msgId)

    const member = data.member as Record<string, unknown> | undefined
    const senderName = (member?.nick as string) ?? author?.username ?? senderId

    const content = stripGuildMention((data.content as string) ?? '').trim()
    const media = await this.downloadAttachments(data, chatId)
    if (!content && !media) return

    await this.handleIncoming(senderId, chatId, content, msgId, {
      platformMessageId: msgId,
      isGroup: !isDirect,
      senderName,
    }, media)
  }

  // ── Attachments ────────────────────────────────────────────────────────────

  /**
   * Download any inbound attachments and cache them under the session uploads
   * dir. Returns the local relative paths, or undefined if none.
   */
  private async downloadAttachments(
    data: Record<string, unknown>,
    chatId: string,
  ): Promise<string[] | undefined> {
    const attachments = data.attachments as
      | Array<Record<string, unknown>>
      | undefined
    if (!attachments || attachments.length === 0) return undefined

    const sessionId = `${this.name}:${chatId}`
    const results: string[] = []
    for (const att of attachments) {
      let url = att.url as string | undefined
      if (!url) continue
      // QQ media URLs sometimes omit the scheme
      if (!/^https?:\/\//.test(url)) url = `https://${url}`
      try {
        const res = await fetch(url)
        if (!res.ok) {
          console.warn(`[qq] Failed to download attachment: ${res.status}`)
          continue
        }
        const buf = new Uint8Array(await res.arrayBuffer())
        const rawName = (att.filename as string) ?? `qq_${Date.now()}`
        const ext = extname(rawName) || guessExt(att.content_type as string)
        const saveName = `qq_${Date.now()}${ext}`
        const rel = await saveToUploads(
          this.workspace,
          sessionId,
          saveName,
          buf,
        )
        results.push(rel)
      } catch (err) {
        console.warn('[qq] Error downloading attachment', errMsg(err))
      }
    }
    return results.length > 0 ? results : undefined
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
    'audio/silk': '.silk',
    'application/pdf': '.pdf',
  }
  return map[contentType.split(';')[0].trim()] ?? ''
}

/** Strip `<@!123>` style mention markup from guild channel message text. */
function stripGuildMention(text: string): string {
  return text.replace(/<@!?\d+>/g, '').replace(/\s+/g, ' ').trim()
}
