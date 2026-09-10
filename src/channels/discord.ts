import { extname } from 'node:path'
import type { Hono } from 'hono'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { VoicePipeline } from '../voice/mod.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import { Span } from '../utils/otel.ts'
import { readMediaFile, saveToUploads } from '../utils/paths.ts'
import { errMsg } from '../utils/truncate.ts'
import { AbstractChannel } from './base.ts'

const DISCORD_API = 'https://discord.com/api/v10'

export interface DiscordChannelOptions {
  token: string
  allowFrom?: string[]
  /** 'mention' = respond to @mentions, DMs, and replies to bot. 'all' = respond to everything. */
  triggerMode?: 'all' | 'mention'
  /** Emoji to react with when a message is received. Set to empty string to disable. Default: '👀' */
  reactionEmoji?: string
  /** Workspace root path — downloaded attachments are cached under <workspace>/uploads/ */
  workspace?: string
  /** Group-chat IDs (Discord channel IDs) that have admin privileges. DMs are admin by default. */
  adminChats?: string[]
  sessionManager?: SessionManager
  voicePipeline?: VoicePipeline
}

/**
 * Discord channel using Gateway WebSocket for receiving and REST for sending.
 *
 * This is a minimal implementation. For production, consider using a library
 * like discord.js.
 */
export class DiscordChannel extends AbstractChannel {
  readonly name = 'discord'
  private token: string
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sessionId: string | null = null
  private seq: number | null = null
  private stopping = false
  private botUserId: string | null = null
  private triggerMode: 'all' | 'mention'
  private reactionEmoji: string
  private workspace: string
  private sessionManager?: SessionManager
  private voicePipeline?: VoicePipeline
  /** Maps channel or thread IDs to human-readable Discord names. */
  private channelNameCache = new Map<string, string>()
  /** Maps thread channel IDs to their parent channel IDs */
  private threadParentMap = new Map<string, string>()

  constructor(bus: Bus, opts: DiscordChannelOptions) {
    super(bus, opts.allowFrom, false, opts.adminChats)
    this.token = opts.token
    this.triggerMode = opts.triggerMode ?? 'mention'
    this.reactionEmoji = opts.reactionEmoji ?? '👀'
    this.workspace = opts.workspace ?? '.'
    this.sessionManager = opts.sessionManager
    this.voicePipeline = opts.voicePipeline
  }

  @Span('DiscordChannel.start')
  async start(_app: Hono): Promise<void> {
    if (!this.token) {
      console.warn('Discord token not set, skipping')
      return
    }

    console.info('Connecting to Discord gateway...')
    await this.connect()
  }

  @Span('DiscordChannel.stop')
  stop(): Promise<void> {
    this.stopping = true
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.ws?.close()
    this.ws = null
    console.info('Discord channel stopped')
    return Promise.resolve()
  }

  @Span('DiscordChannel.send')
  async send(msg: OutboundMessage): Promise<string | null> {
    const url = `${DISCORD_API}/channels/${msg.chatId}/messages`

    // When media is present, send files as multipart/form-data.
    // Discord allows up to 10 attachments per message.
    const hasMedia = msg.media && msg.media.length > 0

    if (hasMedia) {
      // Read all media files first
      const files: Array<{ filename: string; data: Uint8Array<ArrayBuffer> }> =
        []
      for (const mediaPath of msg.media!) {
        try {
          const { filename, data: raw } = await readMediaFile(
            this.workspace,
            `${this.name}:${msg.chatId}`,
            mediaPath,
          )
          // Copy into a plain ArrayBuffer so it's compatible with Blob
          const data = new Uint8Array(new ArrayBuffer(raw.byteLength))
          data.set(raw)
          files.push({ filename, data })
        } catch (err) {
          console.warn(
            `[discord] Failed to read media file ${mediaPath}`,
            errMsg(err),
          )
        }
      }

      if (files.length > 0) {
        // Discord supports up to 10 files; split into batches if needed
        const batchSize = 10
        const chunks = splitMessage(msg.content, 2000)
        let contentIdx = 0

        for (let fileIdx = 0; fileIdx < files.length; fileIdx += batchSize) {
          const batch = files.slice(fileIdx, fileIdx + batchSize)
          const form = new FormData()

          // Include text content in the first batch only
          const payloadContent = contentIdx < chunks.length
            ? chunks[contentIdx++]
            : ''
          const payload: Record<string, unknown> = { content: payloadContent }
          if (fileIdx === 0 && msg.replyTo) {
            payload.message_reference = { message_id: msg.replyTo }
          }
          form.append('payload_json', JSON.stringify(payload))

          for (let i = 0; i < batch.length; i++) {
            form.append(
              `files[${i}]`,
              new Blob([batch[i].data]),
              batch[i].filename,
            )
          }

          const res = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bot ${this.token}` },
            body: form,
          })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            console.error(
              `Failed to send Discord message with files: status=${res.status}, chatId=${msg.chatId}`,
              text,
            )
          }
        }

        // Send any remaining text chunks that didn't fit with a file batch
        while (contentIdx < chunks.length) {
          const body: Record<string, unknown> = {
            content: chunks[contentIdx++],
          }
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            const text = await res.text().catch(() => '')
            console.error(
              `Failed to send Discord message: status=${res.status}, chatId=${msg.chatId}`,
              text,
            )
          }
        }
        return null // media path: don't track ID for edits
      }
    }

    // Text-only path (original behaviour)
    // Discord has a 2000-char limit per message; split if needed
    const chunks = splitMessage(msg.content, 2000)
    let firstMessageId: string | null = null

    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { content: chunks[i] }
      // Only set reply reference on the first chunk
      if (i === 0 && msg.replyTo) {
        body.message_reference = { message_id: msg.replyTo }
      }

      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.error(
          `Failed to send Discord message: status=${res.status}, chatId=${msg.chatId}`,
          text,
        )
      } else if (i === 0) {
        const json = await res.json().catch(() => null) as
          | { id?: string }
          | null
        firstMessageId = json?.id ?? null
      }
    }
    return firstMessageId
  }

  /**
   * Edit an existing Discord message with new content (full replacement).
   * Used for progressive updates — the content is the full accumulated text.
   * Any new media files are sent as additional messages to the same channel.
   */
  override async update(
    messageId: string,
    chatId: string,
    content: string,
    media?: string[],
  ): Promise<void> {
    const chunks = splitMessage(content, 2000)
    const res = await fetch(
      `${DISCORD_API}/channels/${chatId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunks[0] }),
      },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(
        `[discord] Failed to edit message ${messageId}: status=${res.status}`,
        text,
      )
    }
    // If content spilled into extra chunks (edge case), send new messages for the overflow
    for (let i = 1; i < chunks.length; i++) {
      const r = await fetch(`${DISCORD_API}/channels/${chatId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunks[i] }),
      })
      if (!r.ok) {
        const text = await r.text().catch(() => '')
        console.warn(
          `[discord] Failed to send overflow chunk: status=${r.status}`,
          text,
        )
      }
    }
    // Send any new media attachments as separate messages
    if (media && media.length > 0) {
      const url = `${DISCORD_API}/channels/${chatId}/messages`
      for (const mediaPath of media) {
        try {
          const { filename, data: raw } = await readMediaFile(
            this.workspace,
            `${this.name}:${chatId}`,
            mediaPath,
          )
          const data = new Uint8Array(new ArrayBuffer(raw.byteLength))
          data.set(raw)
          const form = new FormData()
          form.append('payload_json', JSON.stringify({ content: '' }))
          form.append('files[0]', new Blob([data]), filename)
          const r = await fetch(url, {
            method: 'POST',
            headers: { Authorization: `Bot ${this.token}` },
            body: form,
          })
          if (!r.ok) {
            const text = await r.text().catch(() => '')
            console.warn(
              `[discord] Failed to send media file ${filename}: status=${r.status}`,
              text,
            )
          }
        } catch (err) {
          console.warn(
            `[discord] Failed to read media file ${mediaPath}`,
            errMsg(err),
          )
        }
      }
    }
  }

  // ── Thread creation ──────────────────────────────────────────────────

  async createThread(
    parentChatId: string,
    name: string,
  ): Promise<string | null> {
    const url = `${DISCORD_API}/channels/${parentChatId}/threads`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          name: name.slice(0, 100),
          type: 11, // PUBLIC_THREAD
          auto_archive_duration: 1440, // 24 hours
        }),
      })

      if (!res.ok) {
        const text = await res.text().catch(() => '')
        console.warn(
          `[discord] Failed to create thread: status=${res.status}`,
          text,
        )
        return null
      }

      const data = await res.json() as { id: string }
      if (data.id) {
        this.threadParentMap.set(data.id, parentChatId)
        console.info(
          `[discord] Created thread ${data.id} in channel ${parentChatId}: "${
            name.slice(0, 100)
          }"`,
        )
      }
      return data.id ?? null
    } catch (err) {
      console.warn('[discord] Thread creation error', errMsg(err))
      return null
    }
  }

  // ── WebSocket logic ───────────────────────────────────────────────────

  @Span('DiscordChannel.getGatewayUrl')
  private async getGatewayUrl(): Promise<string> {
    try {
      const res = await fetch(`${DISCORD_API}/gateway/bot`, {
        headers: { Authorization: `Bot ${this.token}` },
      })
      if (res.ok) {
        const data = await res.json() as { url: string }
        return `${data.url}/?v=10&encoding=json`
      }
    } catch (err) {
      console.warn('Failed to fetch gateway URL, using fallback', err)
    }
    return 'wss://gateway.discord.gg/?v=10&encoding=json'
  }

  private async connect(): Promise<void> {
    const gatewayUrl = await this.getGatewayUrl()
    console.debug(`Connecting to gateway: ${gatewayUrl}`)

    this.ws = new WebSocket(gatewayUrl)

    this.ws.onopen = () => {
      console.debug('WebSocket connected')
    }

    this.ws.onmessage = (event: MessageEvent) => {
      const data = JSON.parse(String(event.data)) as {
        op: number
        d: Record<string, unknown> | null
        s: number | null
        t: string | null
      }

      if (data.s) this.seq = data.s

      switch (data.op) {
        case 10: // Hello
          this.startHeartbeat(
            (data.d as Record<string, number>).heartbeat_interval,
          )
          this.identify()
          break
        case 11: // Heartbeat ACK
          break
        case 7: // Reconnect
          console.info('Gateway requested reconnect')
          this.ws?.close()
          break
        case 9: // Invalid Session
          console.warn('Invalid session, re-identifying after delay')
          this.sessionId = null
          setTimeout(() => this.identify(), 2000)
          break
        case 0: // Dispatch
          this.handleDispatch(data.t!, data.d!).catch((err) =>
            console.error('Error in handleDispatch', errMsg(err))
          )
          break
      }
    }

    this.ws.onclose = (event: CloseEvent) => {
      console.warn(
        `WebSocket closed: code=${event.code}, reason=${event.reason}`,
      )
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      if (!this.stopping) {
        console.info('Reconnecting in 5s...')
        setTimeout(
          () =>
            this.connect().catch((err) =>
              console.error('[discord] Reconnect failed', errMsg(err))
            ),
          5000,
        )
      }
    }

    this.ws.onerror = (event: Event) => {
      console.error('WebSocket error', event)
    }
  }

  private identify(): void {
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15), // GUILDS | GUILD_MESSAGES | DIRECT_MESSAGES | MESSAGE_CONTENT
          properties: { os: 'node', browser: 'bot', device: 'bot' },
        },
      }))
    } catch (err) {
      console.warn('[discord] Identify send failed', errMsg(err))
    }
  }

  private startHeartbeat(intervalMs: number): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ op: 1, d: this.seq }))
        }
      } catch (err) {
        console.warn('[discord] Heartbeat send failed', errMsg(err))
      }
    }, intervalMs)
  }

  private async handleDispatch(
    event: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    if (event === 'READY') {
      this.sessionId = data.session_id as string
      const user = data.user as Record<string, string>
      this.botUserId = user?.id ?? null
      console.info(
        `Discord ready: sessionId=${this.sessionId}, user=${user?.username}, botUserId=${this.botUserId}`,
      )
      return
    }

    if (event === 'GUILD_CREATE') {
      const channels = data.channels as
        | Array<Record<string, unknown>>
        | undefined
      if (channels) {
        this.indexChannelNames(channels)
        console.debug(
          `[discord] GUILD_CREATE: indexed ${channels.length} channels`,
        )
      }

      const threads = data.threads as Array<Record<string, unknown>> | undefined
      if (threads) {
        this.indexChannelNames(threads)
        for (const thread of threads) {
          const threadId = thread.id as string
          const parentId = thread.parent_id as string
          if (threadId && parentId) {
            this.threadParentMap.set(threadId, parentId)
          }
        }
        console.debug(
          `[discord] GUILD_CREATE: indexed ${threads.length} active threads`,
        )
      }
      return
    }

    if (event === 'THREAD_CREATE') {
      const threadId = data.id as string
      const parentId = data.parent_id as string
      const threadName = data.name as string | undefined
      if (threadId && parentId) {
        this.threadParentMap.set(threadId, parentId)
        if (threadName) this.channelNameCache.set(threadId, threadName)
        console.debug(
          `[discord] THREAD_CREATE: ${threadId} -> parent ${parentId}`,
        )
      }
      return
    }

    if (event === 'THREAD_DELETE') {
      const threadId = data.id as string
      if (threadId) {
        this.threadParentMap.delete(threadId)
        console.debug(`[discord] THREAD_DELETE: removed ${threadId}`)
      }
      return
    }

    if (event === 'MESSAGE_CREATE') {
      const author = data.author as Record<string, string>
      // Ignore bot messages
      if ((author as Record<string, unknown>).bot) return

      const content = data.content as string
      const guildId = data.guild_id as string | undefined

      const member = data.member as Record<string, unknown> | undefined
      const nick = member?.nick as string | undefined
      const authorName = nick ??
        (author as Record<string, string> | undefined)?.global_name ??
        author?.username ??
        author?.id

      let silent = false
      const sessionId = `${this.name}:${data.channel_id as string}`
      const state = await this.sessionManager?.getSessionState(sessionId)
      const sessionTriggerMode = state?.config?.triggerMode ?? this.triggerMode

      // Apply trigger mode filter
      if (sessionTriggerMode === 'mention' && guildId) {
        // In a guild: only respond to @mentions or replies to the bot
        if (!this.shouldRespond(data)) silent = true
      }
      // DMs (no guildId) always pass through

      // Add reaction to acknowledge receipt
      if (!silent && this.reactionEmoji) {
        this.addReaction(data.channel_id as string, data.id as string).catch((
          err,
        ) => console.warn('Failed to add reaction', errMsg(err)))
      }

      // Strip bot mention from content so the LLM sees clean text
      const cleaned = this.stripBotMention(content)

      // Download and cache attachments locally, convert to base64 data URIs
      const attachments = data.attachments as
        | Array<Record<string, unknown>>
        | undefined

      // Separate audio attachments from non-audio ones
      const audioAttachments: Array<Record<string, unknown>> = []
      const otherAttachments: Array<Record<string, unknown>> = []
      if (attachments && attachments.length > 0) {
        for (const a of attachments) {
          const ct = a.content_type as string | undefined
          if (ct?.startsWith('audio/')) {
            audioAttachments.push(a)
          } else {
            otherAttachments.push(a)
          }
        }
      }

      // Transcribe audio attachments and append to content
      let finalContent = cleaned
      if (audioAttachments.length > 0 && this.voicePipeline) {
        const transcribed = await this._handleAudioAttachments(audioAttachments)
        finalContent = [cleaned, transcribed].filter(Boolean).join('\n')
      }

      // Non-audio attachments: download as media
      const channelId = data.channel_id as string
      let media: string[] | undefined
      if (otherAttachments.length > 0) {
        const results = await Promise.all(
          otherAttachments.map((a) =>
            this.downloadAttachment(a, `${this.name}:${channelId}`)
          ),
        )
        const uris = results.filter(Boolean) as string[]
        if (uris.length > 0) media = uris
      }

      const channelName = await this.resolveChannelName(channelId)
      const parentChannelId = this.threadParentMap.get(channelId)

      if (parentChannelId && !state) {
        console.log(
          `Thread ${channelId} has parent ${parentChannelId}, building session for thread...`,
        )
        const sessionId = `${this.name}:${channelId}`
        await this.sessionManager?.buildSession(sessionId, {
          id: `${this.name}:${parentChannelId}`,
        })
      }

      this.handleIncoming(
        author.id,
        channelId,
        finalContent,
        data.id as string,
        {
          chatName: channelName ?? undefined,
          isGroup: !!guildId,
          senderName: authorName,
          silent,
        },
        media,
      )
    }
  }

  /**
   * Download a Discord attachment, cache it under the session's uploads dir,
   * and return the local relative path (e.g. "uploads/discord_123.png").
   */
  private async downloadAttachment(
    attachment: Record<string, unknown>,
    sessionId: string,
  ): Promise<string | null> {
    const url = attachment.url as string | undefined
    const filename = attachment.filename as string | undefined
    if (!url || !filename) return null

    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bot ${this.token}` },
      })
      if (!res.ok) {
        console.warn(
          `[discord] Failed to download attachment ${filename}: ${res.status}`,
        )
        return null
      }

      const buf = new Uint8Array(await res.arrayBuffer())

      const ext = extname(filename) || ''
      const saveName = `discord_${attachment.id ?? Date.now()}${ext}`
      const relativePath = await saveToUploads(
        this.workspace,
        sessionId,
        saveName,
        buf,
      )
      console.info(`[discord] Cached attachment to ${relativePath}`)

      return relativePath
    } catch (err) {
      console.warn(
        `[discord] Error downloading attachment ${filename}`,
        errMsg(err),
      )
      return null
    }
  }

  /**
   * Download and transcribe audio attachments, return concatenated text.
   */
  private async _handleAudioAttachments(
    attachments: Array<Record<string, unknown>>,
  ): Promise<string> {
    if (!this.voicePipeline) {
      return attachments.map(() => '[audio]').join('\n')
    }

    const results: string[] = []

    for (const attachment of attachments) {
      const url = attachment.url as string | undefined
      const filename = attachment.filename as string | undefined
      if (!url || !filename) {
        results.push('[audio]')
        continue
      }

      try {
        const res = await fetch(url, {
          headers: { Authorization: `Bot ${this.token}` },
        })
        if (!res.ok) {
          console.warn(
            `[discord] Failed to download audio ${filename}: ${res.status}`,
          )
          results.push('[audio]')
          continue
        }

        const buf = new Uint8Array(await res.arrayBuffer())
        const ext = extname(filename) || '.ogg'
        const attachId = attachment.id as string ?? String(Date.now())
        const text = await this.voicePipeline.processVoice(
          buf,
          ext,
          `discord_${attachId}`,
        )
        results.push(text)
      } catch (err) {
        console.error('[discord] Failed to transcribe audio', errMsg(err))
        results.push('[audio]')
      }
    }

    return results.join('\n')
  }

  /**
   * Add a reaction to a message.
   */
  private async addReaction(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const emoji = encodeURIComponent(this.reactionEmoji)
    const url =
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`
    const res = await fetch(url, {
      method: 'PUT',
      headers: { Authorization: `Bot ${this.token}` },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.warn(`Failed to add reaction: status=${res.status}`, text)
    }
  }

  private indexChannelNames(entries: Array<Record<string, unknown>>): void {
    for (const entry of entries) {
      const id = entry.id as string | undefined
      const name = entry.name as string | undefined
      if (id && name) {
        this.channelNameCache.set(id, name)
      }
    }
  }

  private async resolveChannelName(channelId: string): Promise<string | null> {
    const cached = this.channelNameCache.get(channelId)
    if (cached) return cached

    try {
      const res = await fetch(`${DISCORD_API}/channels/${channelId}`, {
        headers: { Authorization: `Bot ${this.token}` },
      })
      if (!res.ok) {
        return null
      }

      const data = await res.json() as { name?: string }
      if (data.name) {
        this.channelNameCache.set(channelId, data.name)
        return data.name
      }
    } catch (err) {
      console.warn(
        `[discord] Failed to resolve channel name for ${channelId}`,
        errMsg(err),
      )
    }

    return null
  }

  /**
   * Check if the bot should respond to this guild message.
   * Returns true if the bot is @mentioned or the message is a reply to the bot.
   */
  private shouldRespond(data: Record<string, unknown>): boolean {
    // Check if bot is @mentioned
    const mentions = data.mentions as Array<Record<string, string>> | undefined
    if (mentions?.some((m) => m.id === this.botUserId)) {
      return true
    }

    // Check if message is a reply to one of the bot's messages
    const ref = data.message_reference as Record<string, string> | undefined
    const refMsg = data.referenced_message as
      | Record<string, unknown>
      | undefined
    if (ref && refMsg) {
      const refAuthor = refMsg.author as Record<string, string> | undefined
      if (refAuthor?.id === this.botUserId) {
        return true
      }
    }

    return false
  }

  /**
   * Remove the bot's @mention from message content.
   */
  private stripBotMention(content: string): string {
    if (!this.botUserId) return content
    return content
      .replace(new RegExp(`<@!?${this.botUserId}>`, 'g'), '')
      .replace(/^\s+/, '')
      .replace(/\s+$/, '')
  }
}

/**
 * Split a message into chunks that fit within Discord's character limit.
 * Tries to split at newlines when possible.
 */
function splitMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text]

  const chunks: string[] = []
  let remaining = text
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining)
      break
    }
    // Try to split at the last newline within the limit
    let splitIdx = remaining.lastIndexOf('\n', maxLen)
    if (splitIdx <= 0) splitIdx = maxLen
    chunks.push(remaining.slice(0, splitIdx))
    remaining = remaining.slice(splitIdx).replace(/^\n/, '')
  }
  return chunks
}
