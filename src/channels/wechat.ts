/**
 * WeChat iLink Bot channel.
 *
 * Uses weixin_sdk for API calls, persistence,
 * and media download. No additional runtime dependencies required.
 *
 * Login flow:
 *   POST /wechat/login         → generates QR code
 *   POST /wechat/login/wait    → waits for scan confirmation
 *   GET  /wechat/status        → current account / session info
 *   POST /wechat/monitor/start → start message polling
 *   POST /wechat/monitor/stop  → stop message polling
 */

import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { Hono } from 'hono'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import {
  DEFAULT_WEIXIN_BOT_TYPE,
  DEFAULT_WEIXIN_WAIT_TIMEOUT_MS,
  downloadMedia,
  resolveRouteTag,
  resolveWeixinBaseUrl,
  WEIXIN_POLL_INTERVAL_MS,
  WEIXIN_POLL_REQUEST_TIMEOUT_MS,
  WeixinApiClient,
  WeixinMessageItemType,
  WeixinMessageState,
  WeixinMessageType,
  WeixinRepository,
} from './wechat/sdk.ts'
import type {
  InboundMediaResult,
  WeixinAccountRecord,
  WeixinLoginSessionRecord,
  WeixinLoginStartResult,
  WeixinLoginWaitResult,
  WeixinMessage,
  WeixinMessageItem,
} from './wechat/sdk.ts'
import { AbstractChannel } from './base.ts'

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface WeChatChannelOptions {
  workspace: string
  allowFrom?: string[]
}

// ---------------------------------------------------------------------------
// Message text helpers
// ---------------------------------------------------------------------------

function isMediaItem(item: WeixinMessageItem): boolean {
  return (
    item.type === WeixinMessageItemType.IMAGE ||
    item.type === WeixinMessageItemType.FILE ||
    item.type === WeixinMessageItemType.VIDEO ||
    item.type === WeixinMessageItemType.VOICE
  )
}

function findMainMediaItem(
  items: readonly WeixinMessageItem[] | undefined,
): WeixinMessageItem | null {
  if (!items?.length) return null
  const img = items.find(
    (i) =>
      i.type === WeixinMessageItemType.IMAGE &&
      i.image_item?.media?.encrypt_query_param,
  )
  if (img) return img
  const vid = items.find(
    (i) =>
      i.type === WeixinMessageItemType.VIDEO &&
      i.video_item?.media?.encrypt_query_param,
  )
  if (vid) return vid
  const file = items.find(
    (i) =>
      i.type === WeixinMessageItemType.FILE &&
      i.file_item?.media?.encrypt_query_param,
  )
  if (file) return file
  const voice = items.find(
    (i) =>
      i.type === WeixinMessageItemType.VOICE &&
      i.voice_item?.media?.encrypt_query_param &&
      !i.voice_item.text,
  )
  if (voice) return voice
  const ref = items.find(
    (i) =>
      i.type === WeixinMessageItemType.TEXT && i.ref_msg?.message_item &&
      isMediaItem(i.ref_msg.message_item),
  )?.ref_msg?.message_item
  return ref ?? null
}

function bodyFromMessageItems(
  items: readonly WeixinMessageItem[] | undefined,
  mediaResult?: InboundMediaResult | null,
): string {
  if (!items?.length) return ''
  const parts: string[] = []

  for (const item of items) {
    if (item.type === WeixinMessageItemType.TEXT) {
      const text = item.text_item?.text?.trim()
      if (!text) continue
      if (item.ref_msg) {
        const refItem = item.ref_msg.message_item
        if (refItem && isMediaItem(refItem)) {
          parts.push(text)
        } else {
          const refTitle = item.ref_msg.title?.trim()
          const refBody = refTitle ? `[引用: ${refTitle}]` : '[引用]'
          parts.push(`${refBody}\n${text}`)
        }
      } else {
        parts.push(text)
      }
    }
    if (item.type === WeixinMessageItemType.VOICE && item.voice_item?.text) {
      parts.push(item.voice_item.text)
    }
  }

  if (mediaResult) {
    const desc = buildMediaDescription(items, mediaResult)
    if (desc) parts.unshift(desc)
  } else {
    const fallback = buildFallbackMediaDesc(items)
    if (fallback) parts.unshift(fallback)
  }

  return parts.join('\n').trim()
}

function buildMediaDescription(
  items: readonly WeixinMessageItem[],
  result: InboundMediaResult,
): string {
  const main = findMainMediaItem(items)
  if (!main) return ''
  const { filePath, mimeType, fileName } = result
  switch (main.type) {
    case WeixinMessageItemType.IMAGE:
      return `[图片] 本地路径: ${filePath}（MIME: ${mimeType}）`
    case WeixinMessageItemType.VOICE:
      return `[语音] 已转存: ${filePath}（MIME: ${mimeType}）`
    case WeixinMessageItemType.FILE:
      return `[文件: ${
        fileName ?? '文件'
      }] 本地路径: ${filePath}（MIME: ${mimeType}）`
    case WeixinMessageItemType.VIDEO:
      return `[视频] 本地路径: ${filePath}（MIME: ${mimeType}）`
    default:
      return `[媒体] 本地路径: ${filePath}`
  }
}

function buildFallbackMediaDesc(items: readonly WeixinMessageItem[]): string {
  const media = items.filter(isMediaItem)
  if (!media.length) return ''
  return media
    .map((item) => {
      switch (item.type) {
        case WeixinMessageItemType.IMAGE:
          return '[图片，下载失败]'
        case WeixinMessageItemType.VOICE:
          return '[语音，下载失败]'
        case WeixinMessageItemType.FILE: {
          const name = item.file_item?.file_name
          return name ? `[文件: ${name}，下载失败]` : '[文件，下载失败]'
        }
        case WeixinMessageItemType.VIDEO:
          return '[视频，下载失败]'
        default:
          return '[媒体，下载失败]'
      }
    })
    .join('\n')
}

// ---------------------------------------------------------------------------
// Sleep helper
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ---------------------------------------------------------------------------
// WeChatChannel
// ---------------------------------------------------------------------------

export class WeChatChannel extends AbstractChannel {
  readonly name = 'wechat'

  private repository: WeixinRepository
  private apiClient: WeixinApiClient
  private workspace: string
  private mediaDir: string

  // Monitor state
  private _running = false
  private _pollPromise: Promise<void> | null = null

  constructor(bus: Bus, private readonly options: WeChatChannelOptions) {
    super(bus, options.allowFrom)
    this.workspace = options.workspace
    this.mediaDir = join(options.workspace, 'uploads', 'wechat')

    const routeTag = resolveRouteTag()
    this.repository = new WeixinRepository(options.workspace)
    this.apiClient = new WeixinApiClient(routeTag)
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  async start(app: Hono): Promise<void> {
    this._registerRoutes(app)

    const account = this.repository.getLatestAccount()
    if (account) {
      console.info(
        `[wechat] Resuming with stored account: ${account.accountId}`,
      )
      this._startMonitor()
    } else {
      console.info(
        '[wechat] No stored credentials — waiting for login via /wechat/login',
      )
    }
  }

  async stop(): Promise<void> {
    this._stopMonitor()
    if (this._pollPromise) {
      await this._pollPromise
      this._pollPromise = null
    }
    this.repository.close()
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  async send(msg: OutboundMessage): Promise<string | null> {
    if (!msg.content && !msg.media?.length) return null

    try {
      if (msg.media?.length) {
        for (const mediaPath of msg.media) {
          const raw = await readFile(mediaPath)
          const b64 = btoa(String.fromCharCode(...raw))
          await this._sendImage(msg.chatId, b64)
        }
      }
      if (msg.content) {
        await this._sendText(msg.chatId, msg.content)
      }
    } catch (err) {
      console.error('[wechat] Send failed:', err)
    }

    return null
  }

  override update = undefined

  override async presentDecisionText(chatId: string, content: string): Promise<void> {
    await this._sendText(chatId, content)
  }

  override getCapabilities(): import('./capabilities.ts').ChannelCapabilities {
    return {
      conversation: 'direct', format: 'plain', codeBlocks: false, tables: false,
      outboundMedia: ['image'], updates: 'none', threads: 'none', decisions: 'text',
    }
  }

  // ── Routes ────────────────────────────────────────────────────────────────

  private _registerRoutes(app: Hono): void {
    app.post('/wechat/login', async (c) => {
      try {
        const result = await this._startLogin()
        return c.json({ ok: true, ...result })
      } catch (err) {
        console.error('[wechat] Login start error:', err)
        return c.json({ ok: false, error: String(err) }, 500)
      }
    })

    app.post('/wechat/login/wait', async (c) => {
      try {
        const body: { timeoutMs?: number } = await c.req.json().catch(
          () => ({}),
        )
        const result = await this._waitForLogin(body.timeoutMs)
        if (result.connected) this._startMonitor()
        return c.json({ ok: true, ...result })
      } catch (err) {
        console.error('[wechat] Login wait error:', err)
        return c.json({ ok: false, error: String(err) }, 500)
      }
    })

    app.get('/wechat/status', (c) => {
      const lines = this._getStatusLines()
      return c.json({ ok: true, lines })
    })

    app.post('/wechat/monitor/start', (c) => {
      this._startMonitor()
      return c.json({ ok: true, message: 'Monitor started' })
    })

    app.post('/wechat/monitor/stop', (c) => {
      this._stopMonitor()
      return c.json({ ok: true, message: 'Monitor stopped' })
    })
  }

  // ── Login ─────────────────────────────────────────────────────────────────

  private async _startLogin(): Promise<WeixinLoginStartResult> {
    const baseUrl = this.repository.getLatestAccount()?.baseUrl ??
      resolveWeixinBaseUrl()
    const botType = DEFAULT_WEIXIN_BOT_TYPE
    const response = await this.apiClient.fetchQrCode(baseUrl, botType)

    const sessionKey = crypto.randomUUID()
    const now = new Date().toISOString()
    this.repository.saveLoginSession({
      sessionKey,
      qrcode: response.qrcode,
      qrcodeUrl: response.qrcode_img_content,
      baseUrl,
      botType,
      status: 'pending',
      startedAt: now,
      updatedAt: now,
    })

    console.info('[wechat] Login QR code generated')
    return {
      sessionKey,
      qrcodeUrl: response.qrcode_img_content,
      baseUrl,
      botType,
    }
  }

  private async _waitForLogin(
    timeoutMs = DEFAULT_WEIXIN_WAIT_TIMEOUT_MS,
  ): Promise<WeixinLoginWaitResult> {
    const session = this.repository.getLatestLoginSession()
    if (!session) throw new Error('当前没有登录会话，请先发起登录')

    const deadline = Date.now() + timeoutMs

    while (Date.now() < deadline) {
      const remainingMs = Math.max(deadline - Date.now(), 1)
      const requestTimeoutMs = Math.min(
        remainingMs,
        WEIXIN_POLL_REQUEST_TIMEOUT_MS,
      )

      const status = await this.apiClient.fetchQrStatus(
        session.baseUrl,
        session.qrcode,
        requestTimeoutMs,
      )

      if (status.status === 'wait') {
        await sleep(WEIXIN_POLL_INTERVAL_MS)
        continue
      }
      if (status.status === 'scaned') {
        this.repository.updateLoginStatus(session.sessionKey, 'scanned')
        console.info('[wechat] QR code scanned, waiting for confirmation...')
        await sleep(WEIXIN_POLL_INTERVAL_MS)
        continue
      }
      if (status.status === 'expired') {
        this.repository.updateLoginStatus(session.sessionKey, 'expired')
        return { connected: false, message: '二维码已过期，请重新登录' }
      }
      if (status.status === 'confirmed') {
        return this._completeLogin(session, status)
      }
    }

    return {
      connected: false,
      message: `等待扫码超时（${Math.floor(timeoutMs / 1000)}秒）`,
    }
  }

  private _completeLogin(
    session: WeixinLoginSessionRecord,
    status: {
      bot_token?: string
      ilink_bot_id?: string
      baseurl?: string
      ilink_user_id?: string
    },
  ): WeixinLoginWaitResult {
    if (!status.ilink_bot_id || !status.bot_token) {
      this.repository.updateLoginStatus(session.sessionKey, 'failed')
      return {
        connected: false,
        message: '登录失败：服务端未返回 bot token 或 account id',
      }
    }

    const baseUrl = status.baseurl?.trim() || session.baseUrl
    const account: WeixinAccountRecord = {
      accountId: status.ilink_bot_id,
      baseUrl,
      botToken: status.bot_token,
      linkedUserId: status.ilink_user_id,
      savedAt: new Date().toISOString(),
    }
    this.repository.saveAccount(account)
    this.repository.updateLoginStatus(
      session.sessionKey,
      'confirmed',
      status.ilink_bot_id,
      status.ilink_user_id,
    )

    console.info(`[wechat] Login confirmed: account=${account.accountId}`)
    return {
      connected: true,
      message: '微信登录成功',
      accountId: account.accountId,
      linkedUserId: account.linkedUserId,
    }
  }

  private _getStatusLines(): readonly string[] {
    const account = this.repository.getLatestAccount()
    const session = this.repository.getLatestLoginSession()
    const lines: string[] = []
    if (account) {
      lines.push(
        `已登录: account=${account.accountId} user=${
          account.linkedUserId ?? '-'
        } savedAt=${account.savedAt}`,
      )
    } else {
      lines.push('已登录: 否')
    }
    if (session) {
      lines.push(
        `最近登录会话: session=${session.sessionKey} status=${session.status} updatedAt=${session.updatedAt}`,
      )
    }
    return lines
  }

  // ── Monitor (long-poll loop) ──────────────────────────────────────────────

  private _startMonitor(): void {
    if (this._running) return
    this._running = true
    this._pollPromise = this._pollLoop()
    console.info('[wechat] Monitor started')
  }

  private _stopMonitor(): void {
    this._running = false
    console.info('[wechat] Monitor stopping…')
  }

  private async _pollLoop(): Promise<void> {
    let backoffMs = WEIXIN_POLL_INTERVAL_MS

    while (this._running) {
      const account = this.repository.getLatestAccount()
      if (!account) {
        await sleep(5_000)
        continue
      }

      const syncState = this.repository.getSyncState(account.accountId)
      const buf = syncState?.getUpdatesBuf ?? ''

      try {
        const response = await this.apiClient.getUpdates(
          account.baseUrl,
          account.botToken,
          buf,
        )

        if (response.get_updates_buf) {
          this.repository.saveSyncState(
            account.accountId,
            response.get_updates_buf,
          )
        }

        if (response.ret && response.ret !== 0) {
          console.warn(
            `[wechat] getUpdates ret=${response.ret} errmsg=${response.errmsg} errcode=${response.errcode}`,
          )
          backoffMs = Math.min(backoffMs * 2, 30_000)
          await sleep(backoffMs)
          continue
        }

        backoffMs = WEIXIN_POLL_INTERVAL_MS

        if (response.msgs?.length) {
          console.info(`[wechat] Received ${response.msgs.length} message(s)`)
          for (const msg of response.msgs) {
            console.info(
              `[wechat] msg: type=${msg.message_type} state=${msg.message_state} from=${msg.from_user_id} to=${msg.to_user_id} items=${
                msg.item_list?.length ?? 0
              }`,
            )
            await this._processMessage(msg, account.linkedUserId)
          }
        }

        const waitMs = response.longpolling_timeout_ms ??
          WEIXIN_POLL_INTERVAL_MS
        await sleep(Math.max(waitMs, 200))
      } catch (err) {
        console.error('[wechat] Poll error:', err)
        backoffMs = Math.min(backoffMs * 2, 30_000)
        await sleep(backoffMs)
      }
    }
  }

  private async _processMessage(
    msg: WeixinMessage,
    linkedUserId?: string,
  ): Promise<void> {
    console.info(
      `[wechat] _processMessage: type=${msg.message_type} state=${msg.message_state} from=${msg.from_user_id} to=${msg.to_user_id} items=${
        msg.item_list?.length ?? 0
      }`,
    )

    // Skip bot's own replies
    if (msg.message_type === WeixinMessageType.BOT) return

    const chatId = msg.from_user_id?.trim()
    if (!chatId) return

    const dedupKey = `${chatId}:${msg.message_id}`
    if (!this.repository.tryMarkMessageSeen(dedupKey)) return

    // Only accept messages from the linked user (if configured)
    if (linkedUserId && chatId !== linkedUserId) {
      console.info(
        `[wechat] Skipping: from_user_id=${chatId} !== linkedUserId=${linkedUserId}`,
      )
      return
    }

    if (msg.context_token && chatId) {
      this.repository.saveContextToken(chatId, msg.context_token)
    }

    let mediaResult: InboundMediaResult | null = null
    const mainMedia = findMainMediaItem(msg.item_list)
    if (mainMedia) {
      const cdnMedia = mainMedia.image_item?.media ??
        mainMedia.voice_item?.media ??
        mainMedia.file_item?.media ??
        mainMedia.video_item?.media
      if (cdnMedia?.encrypt_query_param) {
        try {
          mediaResult = await downloadMedia(
            cdnMedia.encrypt_query_param,
            cdnMedia.aes_key,
            this.mediaDir,
            mainMedia.file_item?.file_name,
          )
        } catch (err) {
          console.warn('[wechat] Media download failed:', err)
        }
      }
    }

    const text = bodyFromMessageItems(msg.item_list, mediaResult)
    if (!text) {
      console.info(`[wechat] Skipping: empty text after parsing items`)
      return
    }

    console.info(`[wechat] Incoming from ${chatId}: "${text.slice(0, 80)}"`)
    const media = mediaResult ? [mediaResult.filePath] : undefined
    await this.handleIncoming(chatId, chatId, text, String(msg.message_id ?? ''), undefined, media)
  }

  // ── Outbound helpers ──────────────────────────────────────────────────────

  private async _sendText(chatId: string, text: string): Promise<void> {
    const account = this.repository.getLatestAccount()
    if (!account) throw new Error('Not logged in')

    const contextToken = this.repository.getContextToken(chatId)
    const item: WeixinMessageItem = {
      type: WeixinMessageItemType.TEXT,
      text_item: { text },
    }
    const msg: WeixinMessage = {
      from_user_id: account.accountId,
      to_user_id: chatId,
      message_type: WeixinMessageType.BOT,
      message_state: WeixinMessageState.FINISH,
      item_list: [item],
      context_token: contextToken ?? undefined,
    }
    await this.apiClient.sendMessage(account.baseUrl, account.botToken, { msg })
  }

  private async _sendImage(chatId: string, imageBase64: string): Promise<void> {
    const account = this.repository.getLatestAccount()
    if (!account) throw new Error('Not logged in')

    const contextToken = this.repository.getContextToken(chatId)
    const item: WeixinMessageItem = {
      type: WeixinMessageItemType.IMAGE,
      image_item: { data: imageBase64, format: 'base64' },
    }
    const msg: WeixinMessage = {
      from_user_id: account.accountId,
      to_user_id: chatId,
      message_type: WeixinMessageType.BOT,
      message_state: WeixinMessageState.FINISH,
      item_list: [item],
      context_token: contextToken ?? undefined,
    }
    await this.apiClient.sendMessage(account.baseUrl, account.botToken, { msg })
  }
}
