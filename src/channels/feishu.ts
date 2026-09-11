/**
 * Feishu/Lark channel using WebSocket long connection.
 *
 * Requires:
 *   - App ID and App Secret from Feishu Open Platform
 *   - Bot capability enabled
 *   - Event subscription enabled (im.message.receive_v1)
 *
 * Uses feishu_sdk (native fetch/WebSocket) for API calls and WebSocket events.
 * No public IP or webhook endpoint required.
 */

import type { Hono } from 'hono'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type {
  InteractiveCard,
  InteractiveCardDivElement,
  InteractiveCardMarkdownElement,
} from '../utils/feishu_sdk.ts'
import {
  Client,
  EventDispatcher,
  FeishuApiError,
  LoggerLevel,
  WSClient,
} from '../utils/feishu_sdk.ts'
import { Span } from '../utils/otel.ts'
import { readMediaFile, saveToUploads } from '../utils/paths.ts'
import { RingSet } from '../utils/ring-set.ts'
import { errMsg } from '../utils/truncate.ts'
import { AbstractChannel } from './base.ts'
import type { VoicePipeline } from '../voice/mod.ts'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FeishuChannelOptions {
  /** App ID from Feishu Open Platform */
  appId: string
  /** App Secret from Feishu Open Platform */
  appSecret: string
  /** Encryption key for event payloads (optional) */
  encryptKey?: string
  /** Verification token for event subscription (optional) */
  verificationToken?: string
  allowFrom?: string[]
  /** Workspace root path — downloaded files are saved under <workspace>/uploads/ */
  workspace?: string
  /** Group-chat IDs that have admin privileges. DMs are admin by default. */
  adminChats?: string[]
  /** Voice pipeline for STT transcription (optional) */
  voicePipeline?: VoicePipeline
}

// Emoji types: THUMBSUP, OK, EYES, DONE, OnIt, HEART
const SEEN_EMOJI = 'OnIt'

// Non-text message type display labels (mirrors Python reference)
const MSG_TYPE_MAP: Readonly<Record<string, string>> = {
  image: '[image]',
  audio: '[audio]',
  file: '[file]',
  sticker: '[sticker]',
}

// ---------------------------------------------------------------------------
// Post-format helpers (mirrors _extract_post_text in Python reference)
// ---------------------------------------------------------------------------

function extractPostText(contentJson: Record<string, unknown>): string {
  function extractFromLang(
    lang: Record<string, unknown> | null | undefined,
  ): string | null {
    if (!lang) return null
    const content = lang['content']
    if (!Array.isArray(content)) return null
    const textParts: string[] = []
    for (const row of content as Array<Array<Record<string, unknown>>>) {
      if (!Array.isArray(row)) continue
      for (const elem of row) {
        if (elem['tag'] === 'text' && typeof elem['text'] === 'string') {
          textParts.push(elem['text'])
        } else if (
          elem['tag'] === 'at' &&
          typeof elem['user_id'] === 'string'
        ) {
          const name = typeof elem['user_name'] === 'string'
            ? elem['user_name']
            : elem['user_id']
          textParts.push(`@${name}`)
        }
      }
    }
    return textParts.join(' ').trim() || null
  }

  // Try direct format first
  if ('content' in contentJson) {
    const result = extractFromLang(contentJson as Record<string, unknown>)
    if (result) return result
  }

  // Try localized formats
  for (const lang of ['zh_cn', 'en_us', 'ja_jp']) {
    const langContent = contentJson[lang] as Record<string, unknown> | undefined
    const result = extractFromLang(langContent)
    if (result) return result
  }

  return ''
}

// ---------------------------------------------------------------------------
// Card element types
// ---------------------------------------------------------------------------

/** Feishu table element (not in the standard SDK types but supported by the API). */
interface FeishuTableElement {
  tag: 'table'
  page_size: number
  columns: Array<
    { tag: 'column'; name: string; display_name: string; width: string }
  >
  rows: Array<Record<string, string>>
}

/** All element types produced by the card builder. */
type FeishuCardElement =
  | InteractiveCardDivElement
  | InteractiveCardMarkdownElement
  | FeishuTableElement

// ---------------------------------------------------------------------------
// Markdown → Feishu interactive card helpers
// ---------------------------------------------------------------------------

// Regex to match markdown tables (header + separator + data rows)
const TABLE_RE =
  /((?:^[ \t]*\|.+\|[ \t]*\n)(?:^[ \t]*\|[-:\s|]+\|[ \t]*\n)(?:^[ \t]*\|.+\|[ \t]*\n?)+)/gm
const HEADING_RE = /^(#{1,6})\s+(.+)$/gm
const CODE_BLOCK_RE = /(```[\s\S]*?```)/gm

function parseMdTable(tableText: string): FeishuTableElement | null {
  const lines = tableText
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
  if (lines.length < 3) return null

  const split = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((c) => c.trim())

  const headers = split(lines[0])
  const rows = lines.slice(2).map(split)

  const columns = headers.map((h, i) => ({
    tag: 'column' as const,
    name: `c${i}`,
    display_name: h,
    width: 'auto',
  }))

  const rowData = rows.map((r) =>
    Object.fromEntries(headers.map((_, i) => [`c${i}`, r[i] ?? '']))
  )

  return {
    tag: 'table',
    page_size: rows.length + 1,
    columns,
    rows: rowData,
  }
}

function splitHeadings(content: string): FeishuCardElement[] {
  // Protect code blocks
  const codeBlocks: string[] = []
  let protected_ = content
  for (const m of content.matchAll(CODE_BLOCK_RE)) {
    codeBlocks.push(m[1])
    protected_ = protected_.replace(
      m[1],
      `\x00CODE${codeBlocks.length - 1}\x00`,
    )
  }

  const elements: FeishuCardElement[] = []
  let lastEnd = 0
  HEADING_RE.lastIndex = 0

  for (const m of protected_.matchAll(HEADING_RE)) {
    const before = protected_.slice(lastEnd, m.index ?? 0).trim()
    if (before) elements.push({ tag: 'markdown', content: before })
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `**${m[2].trim()}**` },
    })
    lastEnd = (m.index ?? 0) + m[0].length
  }

  const remaining = protected_.slice(lastEnd).trim()
  if (remaining) elements.push({ tag: 'markdown', content: remaining })

  // Restore code blocks
  for (const el of elements) {
    if (el.tag === 'markdown') {
      let c = el.content
      for (let i = 0; i < codeBlocks.length; i++) {
        c = c.replace(`\x00CODE${i}\x00`, codeBlocks[i])
      }
      el.content = c
    }
  }

  return elements.length > 0 ? elements : [{ tag: 'markdown', content }]
}

function buildCardElements(content: string): FeishuCardElement[] {
  const elements: FeishuCardElement[] = []
  let lastEnd = 0
  TABLE_RE.lastIndex = 0

  for (const m of content.matchAll(TABLE_RE)) {
    const before = content.slice(lastEnd, m.index ?? 0)
    if (before.trim()) elements.push(...splitHeadings(before))
    elements.push(
      parseMdTable(m[1]) ?? { tag: 'markdown' as const, content: m[1] },
    )
    lastEnd = (m.index ?? 0) + m[0].length
  }

  const remaining = content.slice(lastEnd)
  if (remaining.trim()) elements.push(...splitHeadings(remaining))

  return elements.length > 0 ? elements : [{ tag: 'markdown', content }]
}

// ---------------------------------------------------------------------------
// FeishuChannel
// ---------------------------------------------------------------------------

export class FeishuChannel extends AbstractChannel {
  readonly name = 'feishu'

  private appId: string
  private appSecret: string
  private encryptKey: string
  private verificationToken: string

  private workspace: string
  private voicePipeline?: VoicePipeline

  private _client: Client | null = null
  private _dispatcher: EventDispatcher | null = null
  private _wsClient: WSClient | null = null
  private _running = false
  private _botOpenId: string | null = null

  // Dedup cache: recently seen message IDs to avoid double-processing
  private _seenIds = new RingSet<string>(200)

  // Track bot's own sent message IDs so replies to them are treated as mentions
  private _botMessageIds = new RingSet<string>(200)

  // User display-name cache: open_id → display name
  private _userNameCache = new Map<string, string>()

  constructor(bus: Bus, opts: FeishuChannelOptions) {
    super(bus, opts.allowFrom, false, opts.adminChats)
    this.appId = opts.appId
    this.appSecret = opts.appSecret
    this.encryptKey = opts.encryptKey ?? ''
    this.verificationToken = opts.verificationToken ?? ''
    this.workspace = opts.workspace ?? '.'
    this.voicePipeline = opts.voicePipeline
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  @Span('FeishuChannel.start')
  async start(app: Hono): Promise<void> {
    if (!this.appId || !this.appSecret) {
      console.warn('[feishu] appId and appSecret are required; skipping')
      return
    }

    // ── Register gateway proxy ────────────────────────────────────────────
    // Proxy /feishu/* → https://open.feishu.cn/* with tenant_access_token
    app.all('/feishu/*', async (c) => {
      if (!this._client) {
        return c.json({ error: 'feishu_client_not_initialized' }, 503)
      }
      let token: string
      try {
        token = await this._client._getTokenManager().getTenantAccessToken()
      } catch (err) {
        return c.json({
          error: 'token_fetch_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 502)
      }
      const url = new URL(c.req.url)
      const upstreamUrl = `https://open.feishu.cn${
        url.pathname.replace(/^\/feishu/, '')
      }${url.search}`
      const reqHeaders = new Headers(c.req.raw.headers)
      reqHeaders.set('Authorization', `Bearer ${token}`)
      reqHeaders.delete('host')
      const body = c.req.method === 'GET' || c.req.method === 'HEAD'
        ? undefined
        : await c.req.raw.arrayBuffer()
      try {
        const upstream = await fetch(upstreamUrl, {
          method: c.req.method,
          headers: reqHeaders,
          body,
        })
        const resHeaders = new Headers(upstream.headers)
        resHeaders.delete('content-encoding')
        return new Response(upstream.body, {
          status: upstream.status,
          headers: resHeaders,
        })
      } catch (err) {
        return c.json({
          error: 'upstream_failed',
          detail: err instanceof Error ? err.message : String(err),
        }, 502)
      }
    })

    this._running = true

    // REST client (for sending messages and reactions)
    this._client = new Client({
      appId: this.appId,
      appSecret: this.appSecret,
      disableTokenCache: false,
    })

    // Event dispatcher — registers only im.message.receive_v1
    this._dispatcher = new EventDispatcher({
      encryptKey: this.encryptKey,
      verificationToken: this.verificationToken,
    }).register({
      'im.message.receive_v1': (data: Record<string, unknown>) =>
        this._onMessage(data),
    })

    // WebSocket long connection (no public IP required)
    this._wsClient = new WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      loggerLevel: LoggerLevel.warn,
    })

    // Fetch bot's own open_id for mention detection
    this._fetchBotInfo().catch((err) =>
      console.warn(
        '[feishu] Could not fetch bot info (mention detection disabled)',
        err,
      )
    )

    // Start in background; reconnect on error
    this._startWsLoop()
    console.info('[feishu] Bot started with WebSocket long connection')
    console.info('[feishu] No public IP or webhook needed')
  }

  @Span('FeishuChannel.stop')
  async stop(): Promise<void> {
    this._running = false
    try {
      this._wsClient?.close()
    } catch {
      // ignore
    }
    this._wsClient = null
    this._dispatcher = null
    this._client = null
    console.info('[feishu] Bot stopped')
  }

  // ── Send ──────────────────────────────────────────────────────────────────

  @Span('FeishuChannel.send')
  async send(msg: OutboundMessage): Promise<string | null> {
    if (!this._client) {
      console.warn('[feishu] Client not initialized')
      return null
    }

    let firstMessageId: string | null = null
    try {
      // Detect thread chatIds: message_id format (e.g. "om_...") vs regular chat/user
      const isThread = this._isThreadChatId(msg.chatId)

      // Determine receive_id_type based on chat_id format:
      //   open_id  → starts with "ou_"
      //   chat_id  → starts with "oc_"
      const receiveIdType = msg.chatId.startsWith('oc_') ? 'chat_id' : 'open_id'

      // Send text content as interactive card (if non-empty)
      if (msg.content.trim()) {
        // Build interactive card with markdown + table support
        const elements = buildCardElements(msg.content)
        const card: InteractiveCard = {
          config: { wide_screen_mode: true },
          elements: elements as InteractiveCard['elements'],
        }

        const cardContent = JSON.stringify(card)
        let res: { code: number; msg?: string; data?: { message_id?: string } }

        if (isThread) {
          // Thread mode: reply to the root message with reply_in_thread
          res = await this._client.im.message.reply({
            path: { message_id: msg.chatId },
            data: {
              msg_type: 'interactive',
              content: cardContent,
              reply_in_thread: true,
            },
          })
        } else if (msg.replyTo) {
          // Reply to a specific message (thread reply). If Feishu rejects the
          // reply target (e.g. invalid/expired parent), fall back to a normal send.
          try {
            res = await this._client.im.message.reply({
              path: { message_id: msg.replyTo },
              data: { msg_type: 'interactive', content: cardContent },
            })
          } catch (err) {
            const isReplyBadRequest = err instanceof FeishuApiError &&
              err.status === 400 &&
              err.path.includes('/open-apis/im/v1/messages/') &&
              err.path.endsWith('/reply')

            if (!isReplyBadRequest) throw err

            console.warn(
              `[feishu] Reply target rejected, fallback to normal send: ${err.message}`,
            )
            res = await this._client.im.message.create({
              params: { receive_id_type: receiveIdType },
              data: {
                receive_id: msg.chatId,
                msg_type: 'interactive',
                content: cardContent,
              },
            })
          }
        } else {
          res = await this._client.im.message.create({
            params: { receive_id_type: receiveIdType },
            data: {
              receive_id: msg.chatId,
              msg_type: 'interactive',
              content: cardContent,
            },
          })
        }

        if (res.code !== 0) {
          console.warn(
            `[feishu] Failed to send message: code=${res.code}, msg=${res.msg}`,
          )
        } else if (res.data?.message_id) {
          this._trackBotMessage(res.data.message_id)
          firstMessageId = res.data.message_id
        }
      }

      // Send each media item as a separate image or file message
      if (msg.media && msg.media.length > 0) {
        for (const mediaPath of msg.media) {
          if (isThread) {
            // For threads, media must also be sent as replies
            await this._sendMediaToThread(msg.chatId, mediaPath)
          } else {
            await this._sendMedia(msg.chatId, receiveIdType, mediaPath)
          }
        }
      }
    } catch (err) {
      console.error('[feishu] Error sending message', err)
    }
    return firstMessageId
  }

  /**
   * Edit an existing Feishu message with new content (full card replacement).
   * Used for progressive updates — the content is the full accumulated text.
   */
  override async update(
    messageId: string,
    chatId: string,
    content: string,
    media?: string[],
  ): Promise<void> {
    if (!this._client) return
    try {
      const elements = buildCardElements(content)
      const card: InteractiveCard = {
        config: { wide_screen_mode: true },
        elements: elements as InteractiveCard['elements'],
      }
      const res = await this._client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: 'interactive', content: JSON.stringify(card) },
      })
      if (res.code !== 0) {
        console.warn(
          `[feishu] Failed to update message ${messageId}: code=${res.code}, msg=${res.msg}`,
        )
      }
      // Send any new media attachments
      if (media && media.length > 0) {
        const receiveIdType = chatId.startsWith('oc_') ? 'chat_id' : 'open_id'
        for (const mediaPath of media) {
          await this._sendMedia(chatId, receiveIdType, mediaPath)
        }
      }
    } catch (err) {
      console.warn(`[feishu] Error updating message ${messageId}`, errMsg(err))
    }
  }

  /**
   * Upload a local file and send it to the given chat as an image or file message.
   * `mediaPath` may be an absolute path or relative to the workspace root.
   */
  private async _sendMedia(
    chatId: string,
    receiveIdType: string,
    mediaPath: string,
  ): Promise<void> {
    if (!this._client) return

    try {
      const { filename, data: fileData, ext } = await readMediaFile(
        this.workspace,
        `${this.name}:${chatId}`,
        mediaPath,
      )

      const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
      const isImage = IMAGE_EXTS.has(ext)

      if (isImage) {
        // Upload image
        const form = new FormData()
        form.append('image_type', 'message')
        form.append('image', new Blob([fileData as BlobPart]), filename)
        const uploadRes = await this._client.im.image.create(form)
        if (uploadRes.code !== 0 || !uploadRes.data?.image_key) {
          console.warn(
            `[feishu] Failed to upload image ${filename}: code=${uploadRes.code}, msg=${uploadRes.msg}`,
          )
          return
        }
        const sendRes = await this._client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: chatId,
            msg_type: 'image',
            content: JSON.stringify({ image_key: uploadRes.data.image_key }),
          },
        })
        if (sendRes.code !== 0) {
          console.warn(
            `[feishu] Failed to send image message: code=${sendRes.code}, msg=${sendRes.msg}`,
          )
        } else if (sendRes.data?.message_id) {
          this._trackBotMessage(sendRes.data.message_id)
        }
      } else {
        // Determine file_type from extension
        const FILE_TYPE_MAP: Record<string, string> = {
          '.mp4': 'mp4',
          '.pdf': 'pdf',
          '.doc': 'doc',
          '.docx': 'doc',
          '.xls': 'xls',
          '.xlsx': 'xls',
          '.ppt': 'ppt',
          '.pptx': 'ppt',
          '.opus': 'opus',
        }
        const fileType = FILE_TYPE_MAP[ext] ?? 'stream'

        // Upload file
        const form = new FormData()
        form.append('file_type', fileType)
        form.append('file_name', filename)
        form.append('file', new Blob([fileData as BlobPart]), filename)
        const uploadRes = await this._client.im.file.create(form)
        if (uploadRes.code !== 0 || !uploadRes.data?.file_key) {
          console.warn(
            `[feishu] Failed to upload file ${filename}: code=${uploadRes.code}, msg=${uploadRes.msg}`,
          )
          return
        }
        const sendRes = await this._client.im.message.create({
          params: { receive_id_type: receiveIdType },
          data: {
            receive_id: chatId,
            msg_type: 'file',
            content: JSON.stringify({ file_key: uploadRes.data.file_key }),
          },
        })
        if (sendRes.code !== 0) {
          console.warn(
            `[feishu] Failed to send file message: code=${sendRes.code}, msg=${sendRes.msg}`,
          )
        } else if (sendRes.data?.message_id) {
          this._trackBotMessage(sendRes.data.message_id)
        }
      }
    } catch (err) {
      console.error(`[feishu] Error sending media ${mediaPath}`, err)
    }
  }

  // ── Thread creation ───────────────────────────────────────────────────────

  /**
   * Create a thread (话题) in a Feishu chat.
   *
   * Sends a starter message to the parent chat, then replies to it with
   * `reply_in_thread: true` to create a topic. Returns the root message_id
   * which subsequent `send()` calls use as the thread identifier.
   */
  async createThread(
    parentChatId: string,
    name: string,
  ): Promise<string | null> {
    if (!this._client) return null

    try {
      const receiveIdType = parentChatId.startsWith('oc_')
        ? 'chat_id'
        : 'open_id'

      // Send a starter message that becomes the thread root
      const card: InteractiveCard = {
        config: { wide_screen_mode: true },
        elements: [{
          tag: 'markdown',
          content: `**${name}**`,
        }] as InteractiveCard['elements'],
      }
      const res = await this._client.im.message.create({
        params: { receive_id_type: receiveIdType },
        data: {
          receive_id: parentChatId,
          msg_type: 'interactive',
          content: JSON.stringify(card),
        },
      })

      if (res.code !== 0 || !res.data?.message_id) {
        console.warn(
          `[feishu] Failed to create thread starter: code=${res.code}, msg=${res.msg}`,
        )
        return null
      }

      const rootMessageId = res.data.message_id
      this._trackBotMessage(rootMessageId)

      // Reply with reply_in_thread to create the topic
      const replyRes = await this._client.im.message.reply({
        path: { message_id: rootMessageId },
        data: {
          msg_type: 'text',
          content: JSON.stringify({ text: `Thread: ${name}` }),
          reply_in_thread: true,
        },
      })

      if (replyRes.code !== 0) {
        console.warn(
          `[feishu] Failed to create thread topic: code=${replyRes.code}, msg=${replyRes.msg}`,
        )
        // Still return rootMessageId — the starter message exists, thread just wasn't promoted
      } else if (replyRes.data?.message_id) {
        this._trackBotMessage(replyRes.data.message_id)
      }

      console.info(
        `[feishu] Created thread "${name}" with root message ${rootMessageId}`,
      )
      return rootMessageId
    } catch (err) {
      console.error('[feishu] Error creating thread', err)
      return null
    }
  }

  // ── Incoming message handler ──────────────────────────────────────────────

  private async _onMessage(data: Record<string, unknown>): Promise<void> {
    try {
      const message = data['message'] as Record<string, unknown> | undefined
      const sender = data['sender'] as Record<string, unknown> | undefined

      if (!message || !sender) return

      const messageId = message['message_id'] as string | undefined
      const senderId =
        (sender['sender_id'] as Record<string, unknown> | undefined)
          ?.['open_id'] as
            | string
            | undefined

      if (!messageId || !senderId) return

      // Dedup — Feishu may deliver the same event multiple times
      if (!this._seenIds.add(messageId)) return

      const chatId = message['chat_id'] as string | undefined ?? senderId
      const chatType = message['chat_type'] as string | undefined // 'p2p' | 'group'
      const msgType = message['message_type'] as string | undefined ?? 'unknown'

      // Hoist mentions early — used for both @bot stripping and mention detection
      const mentions = message['mentions'] as
        | Array<Record<string, unknown>>
        | undefined

      // Parse message content
      let content = ''
      let fileMedia: string[] | undefined
      if (msgType === 'text') {
        try {
          const parsed = JSON.parse(message['content'] as string)
          content = (parsed['text'] as string) ?? ''
        } catch {
          content = (message['content'] as string) ?? ''
        }
        // Strip the bot's @mention key (e.g. "@_user_1") from the text
        if (this._botOpenId && mentions) {
          for (const m of mentions) {
            const id = m['id'] as Record<string, string> | undefined
            if (id?.['open_id'] === this._botOpenId) {
              const key = m['key'] as string | undefined
              if (key) {
                content = content.replace(key, '').replace(/\s+/g, ' ').trim()
              }
              break
            }
          }
        }
      } else if (msgType === 'post') {
        try {
          const parsed = JSON.parse(message['content'] as string) as Record<
            string,
            unknown
          >
          content = extractPostText(parsed)
        } catch {
          content = (message['content'] as string) ?? ''
        }
      } else if (msgType === 'file' || msgType === 'image') {
        const result = await this._handleFileMessage(
          messageId,
          msgType,
          message,
          `${this.name}:${chatId?.startsWith('oc_') ? chatId : senderId}`,
        )
        content = result.content
        if (result.media) fileMedia = result.media
      } else if (msgType === 'audio') {
        content = await this._handleAudioMessage(messageId, message)
      } else {
        content = MSG_TYPE_MAP[msgType] ?? `[${msgType}]`
      }

      if (!content && !fileMedia) return

      // If chatId is a group chat (oc_ prefix), reply there; otherwise reply to the user.
      // Feishu may deliver group @mention events with chat_type='p2p', so rely on the
      // chat_id format rather than chat_type for routing.
      const replyTo = chatId?.startsWith('oc_') ? chatId : senderId

      // Use chatType to determine actual group vs P2P for the mention filter.
      // Note: P2P chats also have oc_-prefixed chat_ids, so chat_id format alone
      // is not reliable for this check.
      const isGroup = chatType === 'group'

      // In group chats, only respond if the bot is @mentioned or the user is
      // replying to one of the bot's own messages.
      let silent = false
      if (isGroup && this._botOpenId) {
        const mentioned = mentions?.some((m) => {
          const id = m['id'] as Record<string, string> | undefined
          return id?.['open_id'] === this._botOpenId
        }) ?? false

        const parentId = message['parent_id'] as string | undefined
        const isReplyToBot = !!parentId && this._botMessageIds.has(parentId)

        if (!mentioned && !isReplyToBot) silent = true
      }

      // Add a reaction only for messages the bot will actually respond to.
      // Audio messages already sent a reaction before STT, skip here.
      if (!silent && msgType !== 'audio') {
        this._addReaction(messageId, SEEN_EMOJI).catch(() => {})
      }

      // Best-effort display name: resolve from contact API with local cache
      const authorName = await this._fetchUserName(senderId)

      await this.handleIncoming(
        senderId,
        replyTo!,
        content,
        messageId,
        {
          messageId,
          isGroup,
          senderName: authorName,
          silent,
        },
        fileMedia,
      )
    } catch (err) {
      console.error('[feishu] Error handling message', err)
    }
  }

  // ── User name resolution ──────────────────────────────────────────────────

  /**
   * Resolve a Feishu user's display name by open_id.
   * Results are cached for the lifetime of the channel.
   * Falls back to `openId` if the API call fails (e.g. missing contact scope).
   */
  private async _fetchUserName(openId: string): Promise<string> {
    const cached = this._userNameCache.get(openId)
    if (cached) return cached

    if (!this._client) return openId
    try {
      const res = await this._client.contact.user.get({
        path: { user_id: openId },
        params: { user_id_type: 'open_id' },
      })
      if (res.code === 0 && res.data?.user) {
        const name = res.data.user.name ?? res.data.user.en_name ?? openId
        this._userNameCache.set(openId, name)
        return name
      }
    } catch (err) {
      // TODO: hint user to add contact scope if we see a 403 error here (requires re-install with new permissions)
      console.debug(
        '[feishu] Could not resolve display name for',
        openId,
        errMsg(err),
      )
    }
    // Cache the fallback too so we don't keep retrying on every message
    this._userNameCache.set(openId, openId)
    return openId
  }

  // ── File / image download ─────────────────────────────────────────────────

  private async _handleFileMessage(
    messageId: string,
    msgType: 'file' | 'image',
    message: Record<string, unknown>,
    sessionId: string,
  ): Promise<{ content: string; media?: string[] }> {
    const fallback = MSG_TYPE_MAP[msgType] ?? `[${msgType}]`
    if (!this._client) return { content: fallback }

    try {
      const rawContent = message['content'] as string | undefined
      if (!rawContent) return { content: fallback }

      const parsed = JSON.parse(rawContent) as Record<string, unknown>

      let fileKey: string
      let fileName: string

      if (msgType === 'image') {
        fileKey = parsed['image_key'] as string
        fileName = `${fileKey}.jpg`
      } else {
        fileKey = parsed['file_key'] as string
        fileName = (parsed['file_name'] as string | undefined) ?? fileKey
      }

      if (!fileKey) return { content: fallback }

      // Download resource from Feishu API
      // The SDK returns a Buffer for binary responses
      type ResourceGet = (
        opts: {
          path: { message_id: string; file_key: string }
          params: { type: string }
        },
      ) => Promise<Uint8Array>
      const buf = await (this._client.im.messageResource as unknown as {
        get: ResourceGet
      }).get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: msgType === 'image' ? 'image' : 'file' },
      })

      // Save to the per-session uploads folder
      const relativePath = await saveToUploads(
        this.workspace,
        sessionId,
        fileName,
        buf,
      )
      console.info(`[feishu] Saved ${msgType} to ${relativePath}`)

      return { content: '', media: [relativePath] }
    } catch (err) {
      console.error(`[feishu] Failed to download ${msgType}`, err)
      return { content: fallback }
    }
  }

  // ── Audio / voice message handler ─────────────────────────────────────────

  private async _handleAudioMessage(
    messageId: string,
    message: Record<string, unknown>,
  ): Promise<string> {
    if (!this._client || !this.voicePipeline) return '[audio]'

    try {
      const rawContent = message['content'] as string | undefined
      if (!rawContent) return '[audio]'

      const parsed = JSON.parse(rawContent) as Record<string, unknown>
      const fileKey = parsed['file_key'] as string | undefined
      if (!fileKey) return '[audio]'

      // Send reaction before starting STT so user knows bot received the message
      this._addReaction(messageId, SEEN_EMOJI).catch(() => {})

      // Download audio via Feishu message resource API
      type ResourceGet = (opts: {
        path: { message_id: string; file_key: string }
        params: { type: string }
      }) => Promise<Uint8Array>
      const buf = await (this._client.im.messageResource as unknown as {
        get: ResourceGet
      }).get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: 'file' },
      })

      // Feishu audio is typically opus in ogg container
      const text = await this.voicePipeline.processVoice(
        buf,
        '.ogg',
        `feishu_${messageId}`,
      )
      console.info(`[feishu] Audio transcribed: ${text.substring(0, 80)}...`)
      return text
    } catch (err) {
      console.error('[feishu] Failed to transcribe audio', err)
      return '[audio]'
    }
  }

  // ── Thread helpers ───────────────────────────────────────────────────────

  /**
   * Detect whether a chatId is a thread identifier (message_id) rather than
   * a regular chat/user ID. Feishu message IDs start with "om_".
   */
  private _isThreadChatId(chatId: string): boolean {
    return chatId.startsWith('om_')
  }

  /**
   * Send a media file as a reply into a thread (topic).
   */
  private async _sendMediaToThread(
    threadRootId: string,
    mediaPath: string,
  ): Promise<void> {
    if (!this._client) return

    try {
      const { filename, data: fileData, ext } = await readMediaFile(
        this.workspace,
        `${this.name}:${threadRootId}`,
        mediaPath,
      )

      const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp'])
      const isImage = IMAGE_EXTS.has(ext)

      if (isImage) {
        const form = new FormData()
        form.append('image_type', 'message')
        form.append('image', new Blob([fileData as BlobPart]), filename)
        const uploadRes = await this._client.im.image.create(form)
        if (uploadRes.code !== 0 || !uploadRes.data?.image_key) {
          console.warn(
            `[feishu] Failed to upload image for thread: ${filename}`,
          )
          return
        }
        const res = await this._client.im.message.reply({
          path: { message_id: threadRootId },
          data: {
            msg_type: 'image',
            content: JSON.stringify({ image_key: uploadRes.data.image_key }),
            reply_in_thread: true,
          },
        })
        if (res.data?.message_id) this._trackBotMessage(res.data.message_id)
      } else {
        const FILE_TYPE_MAP: Record<string, string> = {
          '.mp4': 'mp4',
          '.pdf': 'pdf',
          '.doc': 'doc',
          '.docx': 'doc',
          '.xls': 'xls',
          '.xlsx': 'xls',
          '.ppt': 'ppt',
          '.pptx': 'ppt',
          '.opus': 'opus',
        }
        const fileType = FILE_TYPE_MAP[ext] ?? 'stream'
        const form = new FormData()
        form.append('file_type', fileType)
        form.append('file_name', filename)
        form.append('file', new Blob([fileData as BlobPart]), filename)
        const uploadRes = await this._client.im.file.create(form)
        if (uploadRes.code !== 0 || !uploadRes.data?.file_key) {
          console.warn(`[feishu] Failed to upload file for thread: ${filename}`)
          return
        }
        const res = await this._client.im.message.reply({
          path: { message_id: threadRootId },
          data: {
            msg_type: 'file',
            content: JSON.stringify({ file_key: uploadRes.data.file_key }),
            reply_in_thread: true,
          },
        })
        if (res.data?.message_id) this._trackBotMessage(res.data.message_id)
      }
    } catch (err) {
      console.error(`[feishu] Error sending media to thread ${mediaPath}`, err)
    }
  }

  // ── Bot message ID tracking ──────────────────────────────────────────────

  private _trackBotMessage(messageId: string): void {
    this._botMessageIds.add(messageId)
  }

  // ── Bot info ──────────────────────────────────────────────────────────────

  private async _fetchBotInfo(): Promise<void> {
    if (!this._client) return
    try {
      const token = await this._client._getTokenManager().getTenantAccessToken()
      const res = await fetch('https://open.feishu.cn/open-apis/bot/v3/info', {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json = await res.json() as {
        code: number
        bot?: { open_id?: string }
      }
      if (json.code !== 0) throw new Error(`code=${json.code}`)
      this._botOpenId = json.bot?.open_id ?? null
      console.info(`[feishu] Bot open_id: ${this._botOpenId}`)
    } catch (err) {
      console.warn('[feishu] Failed to fetch bot info', err)
    }
  }

  // ── Reaction ──────────────────────────────────────────────────────────────

  private async _addReaction(
    messageId: string,
    emojiType: string,
  ): Promise<void> {
    if (!this._client) return
    try {
      const res = await this._client.im.messageReaction.create({
        path: { message_id: messageId },
        data: { reaction_type: { emoji_type: emojiType } },
      })
      if (res.code !== 0) {
        console.debug(
          `[feishu] Could not add reaction: code=${res.code}, msg=${res.msg}`,
        )
      }
    } catch (err) {
      console.debug('[feishu] Error adding reaction', err)
    }
  }

  // ── WebSocket start ───────────────────────────────────────────────────────
  // The SDK handles reconnection internally via autoReconnect=true and the
  // WebSocket 'close' event. start() resolves immediately (fire-and-forget
  // reConnect call inside), so we must only call it once.

  private _startWsLoop(): void {
    if (!this._wsClient || !this._dispatcher) return
    this._wsClient
      .start({ eventDispatcher: this._dispatcher })
      .catch((err) => {
        if (this._running) {
          console.warn('[feishu] WebSocket start error', err)
        }
      })
  }
}
