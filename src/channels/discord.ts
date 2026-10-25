import type { DiscordObservationProof } from './integration-contract.ts'
import { InputProcessor, awaitInputSignal } from '../events/input-processor.ts'
import { extname, join } from 'node:path'
import { createHash } from 'node:crypto'
import { workspacePath } from '../utils/paths.ts'
import type { Hono } from 'hono'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import { Span } from '../otel/tracing.ts'
import { readMediaFile, saveToUploads } from '../utils/paths.ts'
import { errMsg } from '../utils/truncate.ts'
import { AbstractChannel, ChannelConnectionError } from './base.ts'
import { unavailableCapabilities, type ChannelCapabilities } from './capabilities.ts'
import { parseYieldRequest, type YieldRequest } from '../sessions/yield-contract.ts'
import { discordPermissions, discordRecord, DiscordPermission as Permission, isDiscordId } from './discord-permissions.ts'
import { DISCORD_READ_OPERATIONS, discordHistoryArguments, discordMessageArguments, type ChannelOperationRequest, type ChannelOperationTarget } from './operations.ts'
import { DISCORD_CONTENT_NOTICE, discordReadHistory, discordReadMessage } from './discord-operations.ts'
import { discordBotIdentity, discordDirectory, discordMembers, inspectDiscordConversation } from './discord-directory.ts'
import type { DiscordAdapterIntegration, DiscordBinding } from './integration-contract.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { WebSocket, getGlobalDispatcher, type MessageEvent } from 'undici'

const DISCORD_API = 'https://discord.com/api/v10'
const NO_MENTIONS = { parse: [], replied_user: false }
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface DiscordChannelOptions {
  token: string
  allowFrom?: string[]
  /** 'mention' = respond to @mentions, DMs, and replies to bot. 'all' = respond to everything. */
  triggerMode?: 'all' | 'mention'
  /** Emoji to react with when a message is received. Set to empty string to disable. Default: '👀' */
  reactionEmoji?: string
  memberIntent?: boolean
  /** Workspace root path — downloaded attachments are cached under <workspace>/uploads/ */
  workspace?: string
  /** Group-chat IDs (Discord channel IDs) that have admin privileges. DMs are admin by default. */
  adminChats?: string[]
  sessionManager?: SessionManager
}

/**
 * Discord channel using Gateway WebSocket for receiving and REST for sending.
 *
 * This is a minimal implementation. For production, consider using a library
 * like discord.js.
 */
export class DiscordChannel extends AbstractChannel {
  readonly name = 'discord'
  readonly operationNames = DISCORD_READ_OPERATIONS
  private token: string
  private ws: WebSocket | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private sessionId: string | null = null
  private seq: number | null = null
  private stopping = false
  private controller = new AbortController()
  private reconnectTimer?: ReturnType<typeof setTimeout>
  private identifyTimer?: ReturnType<typeof setTimeout>
  private heartbeatAcknowledged = true
  private botUserId: string | null = null
  private applicationId: string | null = null
  private decisionMessages = new Map<string, { chatId: string; messageId: string }>()
  private capabilityCache = new Map<string, { expiresAt: number; value: Promise<ChannelCapabilities> }>()
  private triggerMode: 'all' | 'mention'
  private reactionEmoji: string
  private memberIntent: boolean
  private workspace: string
  private sessionManager?: SessionManager
  private inputProcessor = new InputProcessor<Record<string, unknown>>(() => console.warn('[discord] Buffered input processing failed; batch dropped.'))
  private observationProcessor = new InputProcessor<{proof:DiscordObservationProof;data:Record<string,unknown>}>()
  private observationPublisher = async (items: {proof:DiscordObservationProof;data:Record<string,unknown>}[], signal:AbortSignal, semantic?: {type:string;data:Record<string,unknown>}) => {
    if (!semantic) return // ordinary emit is not a service wake capability
    if (!this.integration?.wakeObservation) throw new Error('Observation service unavailable')
    await this.integration.wakeObservation(items[0]!.proof, items.map(item => item.data), semantic, signal)
  }
  private classifyObservation(proof:DiscordObservationProof,data:Record<string,unknown>,signal:AbortSignal) {
    return this.integration?.classifyObservation?.(proof,data,signal) ?? Promise.resolve({label:'unknown' as const,confidence:0})
  }
  private createObservationProcessor() {
    const id = this.integration?.processorStorageId
    return new InputProcessor<{proof:DiscordObservationProof;data:Record<string,unknown>}>(
      () => console.warn('[discord] Observation processing failed; no fallback wake'),100,undefined,
      id ? {journalPath:workspacePath(this.workspace, join('.events','observation-inbox-'+createHash('sha256').update(id).digest('hex')+'.json')),
        recover: row => ({signal:this.controller.signal,publish:this.observationPublisher,classify:signal=>this.classifyObservation(row.item.proof,row.item.data,signal)})} : undefined)
  }
  private botProcessorCooldowns = new Map<string, number>()
  private integration?: DiscordAdapterIntegration
  /** Maps channel or thread IDs to human-readable Discord names. */
  private channelNameCache = new Map<string, string>()
  /** Maps thread channel IDs to their parent channel IDs */
  private threadParentMap = new Map<string, string>()

  constructor(bus: Bus, opts: DiscordChannelOptions) {
    super(bus, opts.allowFrom, false, opts.adminChats)
    this.token = opts.token
    this.triggerMode = opts.triggerMode ?? 'mention'
    this.reactionEmoji = opts.reactionEmoji ?? '👀'
    this.memberIntent = opts.memberIntent ?? false
    this.workspace = opts.workspace ?? '.'
    this.sessionManager = opts.sessionManager
  }

  private processedPublisher(revision: string) {
    return async (items: Record<string, unknown>[], signal: AbortSignal) => {
            // Re-admit every original message; revocation or revision changes drop the whole batch.
            for (const item of items) {
              const proof = await awaitInputSignal(this.integration!.admit({ chatId: String(item.channel_id),
                senderId: String((item.author as Record<string, unknown>).id), messageId: String(item.id) }, signal).then(proof => {
                  if (signal.aborted) this.integration!.discard(proof.admissionId)
                  return proof
                }), signal)
              signal.throwIfAborted()
              this.integration!.discard(proof.admissionId)
              if (proof.processorRevision !== revision) return
            }
            const latest = items[items.length - 1]!
            const batch = items.length === 1 ? latest : { ...latest,
              content: '[Buffered platform messages from the same sender; untrusted content]\n' +
                items.map(item => JSON.stringify({ id: item.id, author: item.author, content: item.content })).join('\n'),
              attachments: items.flatMap(item => (item.attachments as unknown[] | undefined) ?? []),
            }
            signal.throwIfAborted()
            await this.handleDispatch('MESSAGE_CREATE', batch, revision, signal)
    }
  }

  private createInputProcessor() {
    const storageId = this.integration?.processorStorageId
    return new InputProcessor<Record<string, unknown>>(
      () => console.warn('[discord] Processor attempt failed (retry, expiry or authority failure); no fallback wake.'), 100, undefined,
      storageId ? {
        journalPath: workspacePath(this.workspace, join('.events', 'processor-inbox-' + createHash('sha256').update(storageId).digest('hex') + '.json')),
        recover: row => {
          try {
            const key: unknown = JSON.parse(row.key)
            if (!Array.isArray(key) || key.length !== 3 || typeof key[2] !== 'string') return undefined
            return { signal: this.controller.signal, publish: this.processedPublisher(key[2]) }
          } catch { return undefined }
        },
      } : undefined)
  }

  setDiscordIntegration(integration: DiscordAdapterIntegration): void {
    if (this.integration) throw new Error('Discord integration is immutable.')
    this.integration = integration
    this.inputProcessor = this.createInputProcessor()
    this.observationProcessor = this.createObservationProcessor()
  }

  /** Host-owned trusted Web tool transport; never exposed as an arbitrary REST tool. */
  trustedWebRequest(path: string, init: RequestInit): Promise<unknown> {
    return this.api(path, init)
  }

  directory(guildId: string | undefined, after: string | undefined, signal: AbortSignal) {
    return discordDirectory((path, init) => this.api(path, init), signal, guildId, after)
  }

  inspectConversation(chatId: string, senderId: string, signal: AbortSignal) {
    return inspectDiscordConversation((path, init) => this.api(path, init), chatId, senderId, signal)
  }

  members(guildId: string, query: string, signal: AbortSignal) {
    return discordMembers((path, init) => this.api(path, init), guildId, query, signal)
  }

  async inspectTarget(target: DiscordBinding['target'], signal: AbortSignal): Promise<{ botUserId: string; roleIds: string[] }> {
    if (target.kind === 'dm') {
      const [botUserId, user] = await Promise.all([
        discordBotIdentity((path, init) => this.api(path, init), signal),
        this.api(`/users/${target.userId}`, { signal }),
      ])
      const recipient = discordRecord(user)
      if (recipient.id !== target.userId || recipient.bot === true) throw new Error('A DM assignment requires a real Discord user.')
      return { botUserId, roleIds: [] }
    }
    const directory = await this.directory(target.guildId, undefined, signal)
    const channel = directory.channels.find(channel => channel.id === target.channelId)
    if (!channel?.supported || !channel.canView || !channel.canSend) throw new Error('Discord channel is unavailable, unsupported, or missing View/Send permission.')
    return { botUserId: directory.botUserId, roleIds: directory.roles.map(role => role.id) }
  }

  protected override async request(input: string | URL, init: RequestInit = {}): Promise<Response> {
    const signal = AbortSignal.any([this.controller.signal, ...(init.signal ? [init.signal] : [])])
    for (let attempt = 0; ; attempt++) {
      const response = await super.request(input, { ...init, signal })
      if (response.status !== 429 || attempt >= 3 || !String(input).startsWith(`${DISCORD_API}/`)) return response
      const rate = z.object({ retry_after: z.number().positive().max(60) }).parse(await response.json())
      await delay(Math.ceil(rate.retry_after * 1000), undefined, { signal })
    }
  }

  @Span('DiscordChannel.start')
  async start(_app: Hono): Promise<void> {
    if (!this.token) {
      throw new Error('Discord credentials are required')
    }
    this.stopping = false
    await Promise.all([this.inputProcessor.stop(),this.observationProcessor.stop()])
    this.capabilityCache.clear()
    this.controller = new AbortController()
    this.inputProcessor = this.createInputProcessor()
    this.observationProcessor = this.createObservationProcessor()
    this.setAccepting(true)
    this.reportState('connecting')

    console.info('Connecting to Discord gateway...')
    try {
      await this.connect()
    } catch (error) {
      if (error instanceof ChannelConnectionError) throw error
      throw new Error('Discord connection failed')
    }
  }

  @Span('DiscordChannel.stop')
  stop(): Promise<void> {
    const processing = Promise.all([this.inputProcessor.stop(),this.observationProcessor.stop()]).then(() => {})
    this.integration?.invalidate()
    this.stopping = true
    this.controller.abort()
    this.setAccepting(false)
    clearTimeout(this.reconnectTimer)
    clearTimeout(this.identifyTimer)
    this.reconnectTimer = undefined
    this.identifyTimer = undefined
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
    if (this.ws) {
      this.ws.onopen = this.ws.onclose = this.ws.onmessage = this.ws.onerror = null
      this.ws.close()
    }
    this.ws = null
    this.sessionId = null
    this.seq = null
    this.botUserId = null
    this.applicationId = null
    this.decisionMessages.clear()
    this.capabilityCache.clear()
    this.reportState('disconnected')
    console.info('Discord channel stopped')
    return processing
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
            this.logicalSessionId(msg.chatId),
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
          const payload: Record<string, unknown> = { content: payloadContent, allowed_mentions: NO_MENTIONS }
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

          const res = await this.request(url, {
            method: 'POST',
            headers: { Authorization: `Bot ${this.token}` },
            body: form,
          })
          if (!res.ok) {
            await res.body?.cancel()
            console.error(
              `Failed to send Discord message with files: status=${res.status}, chatId=${msg.chatId}`,
            )
          }
        }

        // Send any remaining text chunks that didn't fit with a file batch
        while (contentIdx < chunks.length) {
          const body: Record<string, unknown> = {
            content: chunks[contentIdx++],
            allowed_mentions: NO_MENTIONS,
          }
          const res = await this.request(url, {
            method: 'POST',
            headers: {
              Authorization: `Bot ${this.token}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
          })
          if (!res.ok) {
            await res.body?.cancel()
            console.error(
              `Failed to send Discord message: status=${res.status}, chatId=${msg.chatId}`,
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
    let delivered = true

    for (let i = 0; i < chunks.length; i++) {
      const body: Record<string, unknown> = { content: chunks[i], allowed_mentions: NO_MENTIONS }
      // Only set reply reference on the first chunk
      if (i === 0 && msg.replyTo) {
        body.message_reference = { message_id: msg.replyTo }
      }

      const res = await this.request(url, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      if (!res.ok) {
        delivered = false
        await res.body?.cancel()
        console.error(
          `Failed to send Discord message: status=${res.status}, chatId=${msg.chatId}`,
        )
      } else {
        const json = await res.json().catch(() => null) as
          | { id?: unknown }
          | null
        if (!isDiscordId(json?.id)) delivered = false
        else if (i === 0) firstMessageId = json.id
      }
    }
    return delivered ? firstMessageId : null
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
    const res = await this.request(
      `${DISCORD_API}/channels/${chatId}/messages/${messageId}`,
      {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunks[0], allowed_mentions: NO_MENTIONS }),
      },
    )
    if (!res.ok) {
      await res.body?.cancel()
      console.warn(
        `[discord] Failed to edit message ${messageId}: status=${res.status}`,
      )
    }
    // If content spilled into extra chunks (edge case), send new messages for the overflow
    for (let i = 1; i < chunks.length; i++) {
      const r = await this.request(`${DISCORD_API}/channels/${chatId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bot ${this.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content: chunks[i], allowed_mentions: NO_MENTIONS }),
      })
      if (!r.ok) {
        await r.body?.cancel()
        console.warn(
          `[discord] Failed to send overflow chunk: status=${r.status}`,
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
            this.logicalSessionId(chatId),
            mediaPath,
          )
          const data = new Uint8Array(new ArrayBuffer(raw.byteLength))
          data.set(raw)
          const form = new FormData()
          form.append('payload_json', JSON.stringify({ content: '', allowed_mentions: NO_MENTIONS }))
          form.append('files[0]', new Blob([data]), filename)
          const r = await this.request(url, {
            method: 'POST',
            headers: { Authorization: `Bot ${this.token}` },
            body: form,
          })
          if (!r.ok) {
            await r.body?.cancel()
            console.warn(
              `[discord] Failed to send media file ${filename}: status=${r.status}`,
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

  private async api(path: string, init: RequestInit = {}): Promise<unknown> {
    const controller = this.controller
    const res = await this.request(`${DISCORD_API}${path}`, {
      ...init,
      headers: { Authorization: `Bot ${this.token}`, 'Content-Type': 'application/json' },
      signal: init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal,
    })
    if (!res.ok) {
      await res.body?.cancel()
      throw new Error(`Discord request failed: status=${res.status}`)
    }
    let data: unknown
    try {
      data = res.status === 204 ? null : await res.json()
    } catch {
      init.signal?.throwIfAborted()
      this.assertConnection()
      throw new Error('Invalid Discord JSON response')
    }
    init.signal?.throwIfAborted()
    this.assertConnection()
    if (this.stopping || controller !== this.controller || controller.signal.aborted) {
      throw new Error('Discord channel is disconnected')
    }
    return data
  }

  private async guildAccess(channel: Record<string, unknown>, signal?: AbortSignal) {
    const guildId = channel.guild_id
    if (!isDiscordId(guildId)) throw new Error('Invalid Discord guild')
    let botId = this.botUserId
    if (!isDiscordId(botId)) {
      const user = discordRecord(await this.api('/users/@me', { signal }))
      if (!isDiscordId(user.id) || user.bot !== true) throw new Error('Invalid Discord bot identity')
      botId = user.id
    }
    const [guildData, roles, memberData] = await Promise.all([
      this.api(`/guilds/${guildId}`, { signal }),
      this.api(`/guilds/${guildId}/roles`, { signal }),
      this.api(`/guilds/${guildId}/members/${botId}`, { signal }),
    ])
    const guild = discordRecord(guildData), member = discordRecord(memberData)
    if (guild.id !== guildId || discordRecord(member.user).id !== botId) throw new Error('Invalid Discord guild membership')
    let permissionChannel = channel
    if (channel.type === 10 || channel.type === 11 || channel.type === 12) {
      if (!isDiscordId(channel.parent_id)) throw new Error('Invalid Discord thread parent')
      permissionChannel = discordRecord(await this.api(`/channels/${channel.parent_id}`, { signal }))
      if (permissionChannel.id !== channel.parent_id || permissionChannel.guild_id !== guildId) {
        throw new Error('Invalid Discord thread parent')
      }
    }
    const permissions = discordPermissions(guildId, botId, guild.owner_id, roles, member, permissionChannel.permission_overwrites)
    return { guildId, guild, roles, member, permissionChannel, permissions }
  }

  private async assertReadAccess(target: ChannelOperationTarget): Promise<void> {
    target.signal.throwIfAborted()
    this.assertConnection()
    if (this.stopping || !isDiscordId(target.chatId) || !isDiscordId(target.senderId) || !this.isAllowed(target.senderId)) {
      throw new Error('Discord read access is unavailable for the current sender or conversation.')
    }
    const channel = discordRecord(await this.api(`/channels/${target.chatId}`, { signal: target.signal }))
    if (channel.id !== target.chatId) throw new Error('Invalid Discord conversation response')
    if (channel.type === 1 && !channel.guild_id) {
      if (!Array.isArray(channel.recipients) || channel.recipients.length !== 1
        || discordRecord(channel.recipients[0]).id !== target.senderId
        || discordRecord(channel.recipients[0]).bot === true) {
        throw new Error('Discord DM does not belong to the current sender.')
      }
      return
    }
    if (typeof channel.type !== 'number' || ![0, 5, 10, 11].includes(channel.type)) {
      throw new Error('Discord reads support guild text, announcements, public threads and direct messages; private threads and other conversation types are not implemented.')
    }
    const access = await this.guildAccess(channel, target.signal)
    const required = Permission.view | Permission.readHistory
    if ((access.permissions & required) !== required) throw new Error('Discord bot lacks View Channel or Read Message History permission.')
    const member = discordRecord(await this.api(`/guilds/${access.guildId}/members/${target.senderId}`, { signal: target.signal }))
    const user = discordRecord(member.user)
    if (user.id !== target.senderId || user.bot === true) throw new Error('Invalid Discord sender membership')
    const permissions = discordPermissions(access.guildId, target.senderId, access.guild.owner_id,
      access.roles, member, access.permissionChannel.permission_overwrites)
    if ((permissions & required) !== required) throw new Error('Discord sender lacks View Channel or Read Message History permission.')
  }

  async executeOperation(request: ChannelOperationRequest, target: ChannelOperationTarget): Promise<unknown> {
    if (request.name !== 'discord_history' && request.name !== 'discord_message_get') {
      throw new Error('Operation is not implemented for Discord.')
    }
    const operation: ChannelOperationRequest = request.name === 'discord_history'
      ? { name: request.name, args: discordHistoryArguments.parse(request.args) }
      : { name: request.name, args: discordMessageArguments.parse(request.args) }
    await this.assertReadAccess(target)
    if (operation.name === 'discord_history') {
      const input = operation.args
      const limit = input.limit ?? 20
      const query = new URLSearchParams({ limit: String(limit), ...(input.before ? { before: input.before } : {}) })
      const data = await this.api(`/channels/${target.chatId}/messages?${query}`, { signal: target.signal })
      return discordReadHistory(data, target.chatId, limit, input.before)
    }
    const input = operation.args
    const data = await this.api(`/channels/${target.chatId}/messages/${input.messageId}`, { signal: target.signal })
    return { platform: 'discord', message: discordReadMessage(data, target.chatId, input.messageId), contentNotice: DISCORD_CONTENT_NOTICE }
  }

  override async getCapabilities(chatId: string): Promise<ChannelCapabilities> {
    return this.capabilities(chatId)
  }

  private async capabilities(chatId: string, refresh = false): Promise<ChannelCapabilities> {
    if (this.stopping || !this.token || !isDiscordId(chatId)) return unavailableCapabilities()
    const controller = this.controller
    let cached = this.capabilityCache.get(chatId)
    if (refresh || !cached || cached.expiresAt <= Date.now()) {
      // Share in-flight reads across progressive chunks, but never reuse this snapshot for thread creation.
      cached = { expiresAt: Date.now() + 15_000, value: this.resolveCapabilities(chatId) }
      this.capabilityCache.delete(chatId)
      this.capabilityCache.set(chatId, cached)
      if (this.capabilityCache.size > 500) this.capabilityCache.delete(this.capabilityCache.keys().next().value!)
    }
    const capabilities = await cached.value
    if (controller !== this.controller || controller.signal.aborted) return unavailableCapabilities()
    return {
      ...capabilities, outboundMedia: [...capabilities.outboundMedia],
      decisions: capabilities.updates !== 'none' && this.applicationId && this.botUserId && this.ws?.readyState === 1
        ? 'buttons' : 'text',
    }
  }

  private async resolveCapabilities(chatId: string): Promise<ChannelCapabilities> {
    try {
      const channel = discordRecord(await this.api(`/channels/${chatId}`))
      if (channel.id !== chatId) return unavailableCapabilities()
      const thread = channel.type === 10 || channel.type === 11 || channel.type === 12
      const conversation = channel.type === 1 ? 'direct'
        : thread ? 'thread' : [0, 3, 5, 15, 16].includes(channel.type as number) ? 'group' : 'unknown'
      const unavailable = { ...unavailableCapabilities(), conversation } as ChannelCapabilities
      if (conversation === 'unknown') return unavailable
      let permissions = 0n
      let writable = channel.type === 1 && !channel.guild_id
      if (channel.guild_id) {
        const access = await this.guildAccess(channel)
        const member = access.member
        permissions = access.permissions
        const has = (bits: bigint) => (permissions & bits) === bits
        if (member.communication_disabled_until != null
          && (typeof member.communication_disabled_until !== 'string'
            || !Number.isFinite(Date.parse(member.communication_disabled_until))
            || Date.parse(member.communication_disabled_until) > Date.now())) return unavailable
        if (thread) {
          const metadata = discordRecord(channel.thread_metadata)
          // Private membership and reopening archived/locked threads are not implemented.
          writable = channel.type !== 12 && metadata.archived === false && metadata.locked === false
            && has(Permission.view | Permission.sendInThreads)
        } else {
          writable = (channel.type === 0 || channel.type === 5) && has(Permission.view | Permission.send)
        }
      }
      const threadBits = Permission.view | Permission.createPublicThreads | Permission.sendInThreads
      const threads = channel.type === 0 && !!channel.guild_id && (permissions & threadBits) === threadBits ? 'public' : 'none'
      if (!writable) return { ...unavailable, threads }
      return {
        conversation, format: 'markdown', codeBlocks: true, tables: false,
        outboundMedia: channel.type === 1 || (permissions & Permission.attach) !== 0n ? ['image', 'file', 'audio', 'video'] : [],
        updates: 'replace', threads, decisions: 'text',
      }
    } catch {
      return unavailableCapabilities()
    }
  }

  async createThread(
    parentChatId: string,
    name: string,
  ): Promise<string | null> {
    const controller = this.controller
    if (!(name.trim()) || (await this.capabilities(parentChatId, true)).threads !== 'public') return null
    if (controller !== this.controller || controller.signal.aborted) return null
    const url = `${DISCORD_API}/channels/${parentChatId}/threads`
    try {
      const res = await this.request(url, {
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
        await res.body?.cancel()
        console.warn(
          `[discord] Failed to create thread: status=${res.status}`,
        )
        return null
      }

      const data = discordRecord(await res.json())
      if (this.stopping || controller !== this.controller || controller.signal.aborted
        || !isDiscordId(data.id) || data.type !== 11 || data.parent_id !== parentChatId) return null
      if (data.id) {
        this.threadParentMap.set(data.id, parentChatId)
        console.info(
          `[discord] Created thread ${data.id} in channel ${parentChatId}: "${
            name.slice(0, 100)
          }"`,
        )
      }
      return data.id ?? null
    } catch {
      console.warn('[discord] Thread creation failed')
      return null
    }
  }

  async presentDecision(chatId: string, request: YieldRequest, content: string): Promise<void> {
    const controller = this.controller
    request = parseYieldRequest(request, request.sessionId)
    if (!REQUEST_ID.test(request.id) || request.recipient.kind !== 'user'
      || (await this.capabilities(chatId, true)).decisions !== 'buttons') {
      throw new Error('Discord decision buttons are unavailable')
    }
    const fullQuestion = `${request.question}\n${request.options.map((option, i) => `${i + 1}. ${option}`).join('\n')}`
    const text = [request.question, ...request.options].every(value => content.includes(value))
      ? content : [content, fullQuestion].filter(Boolean).join('\n\n')
    const chunks = splitMessage(text, 2000)
    const components = [{
      type: 1,
      components: [
        ...request.options.map((option, i) => ({
          type: 2, style: 1, label: `${i + 1}. ${option}`.slice(0, 80).replace(/[\uD800-\uDBFF]$/, ''),
          custom_id: `yield:${request.id}:${i + 1}`,
        })),
        { type: 2, style: 2, label: 'Cancel', custom_id: `yield:${request.id}:cancel` },
      ],
    }]
    for (let i = 0; i < chunks.length; i++) {
      if (controller !== this.controller || controller.signal.aborted) throw new Error('Discord channel is disconnected')
      const message = discordRecord(await this.api(`/channels/${chatId}/messages`, {
        method: 'POST',
        body: JSON.stringify({ content: chunks[i], allowed_mentions: NO_MENTIONS, ...(i === chunks.length - 1 ? { components } : {}) }),
      }))
      if (!isDiscordId(message.id)) throw new Error('Invalid Discord decision message')
      if (i === chunks.length - 1) {
        this.decisionMessages.set(request.id, { chatId, messageId: message.id })
        if (this.decisionMessages.size > 500) this.decisionMessages.delete(this.decisionMessages.keys().next().value!)
      }
    }
  }

  private async handleInteraction(data: Record<string, unknown>): Promise<void> {
    const controller = this.controller
    if (this.stopping || !this.applicationId || !this.botUserId || data.application_id !== this.applicationId
      || data.type !== 3 || !isDiscordId(data.id) || !isDiscordId(data.channel_id)
      || typeof data.token !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._~+/=-]{0,2047}$/.test(data.token)) return
    // Defer before any authorization/session lookup: interaction deadlines are only three seconds.
    const callback = await this.request(`${DISCORD_API}/interactions/${data.id}/${encodeURIComponent(data.token)}/callback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 5, data: { flags: 64, allowed_mentions: NO_MENTIONS } }),
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2500)]),
    })
    if (!callback.ok) {
      await callback.body?.cancel()
      return
    }
    if (controller !== this.controller || controller.signal.aborted) return
    let result = 'This decision could not be accepted. It may have expired, already been answered, or belong to another user.'
    let accepted: { chatId: string; messageId: string } | undefined
    try {
      const component = discordRecord(data.data), message = discordRecord(data.message)
      const author = discordRecord(message.author)
      const actor = discordRecord(data.guild_id ? discordRecord(data.member).user : data.user)
      const match = typeof component.custom_id === 'string' ? /^yield:(.+):(1|2|3|cancel)$/.exec(component.custom_id) : null
      if (component.component_type !== 2 || !match || !REQUEST_ID.test(match[1])
        || !isDiscordId(actor.id) || actor.bot === true || actor.system === true
        || (data.guild_id !== undefined && !isDiscordId(data.guild_id))
        || author.id !== this.botUserId || author.bot !== true
        || (data.user !== undefined && discordRecord(data.user).id !== actor.id)
        || (message.application_id !== undefined && message.application_id !== this.applicationId)
        || (message.channel_id !== undefined && message.channel_id !== data.channel_id)) throw new Error('Invalid decision')
      const delivered = this.decisionMessages.get(match[1])
      if (!delivered || delivered.chatId !== data.channel_id || delivered.messageId !== message.id) throw new Error('Unknown decision')
      const option = match[2] === 'cancel' ? 'cancel' : Number(match[2]) as 1 | 2 | 3
      result = await this.answerDecision({ chatId: data.channel_id, senderId: actor.id, requestId: match[1], option })
      accepted = delivered
    } catch {
      // Handler and transport errors can contain private context. Never echo their raw messages.
    }
    if (controller !== this.controller || controller.signal.aborted) return
    if (accepted) {
      await this.api(`/channels/${accepted.chatId}/messages/${accepted.messageId}`, {
        method: 'PATCH', body: JSON.stringify({ components: [], allowed_mentions: NO_MENTIONS }),
      }).catch(() => { console.warn('[discord] Could not clear decision buttons') })
    }
    if (controller !== this.controller || controller.signal.aborted) return
    const response = await this.request(`${DISCORD_API}/webhooks/${this.applicationId}/${encodeURIComponent(data.token)}/messages/@original`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ content: result.slice(0, 2000) || 'Decision accepted.', allowed_mentions: NO_MENTIONS }),
    })
    if (!response.ok) await response.body?.cancel()
  }

  // ── WebSocket logic ───────────────────────────────────────────────────

  private async getGatewayUrl(): Promise<string> {
    let res: Response
    try {
      res = await this.request(`${DISCORD_API}/gateway/bot`, {
        headers: { Authorization: `Bot ${this.token}` },
        signal: AbortSignal.any([this.controller.signal, AbortSignal.timeout(15_000)]),
      })
    } catch {
      throw new ChannelConnectionError('network')
    }
    if (res.ok) {
      const data = await res.json() as { url: string }
      return `${data.url}/?v=10&encoding=json`
    }
    await res.body?.cancel()
    throw new ChannelConnectionError(res.status === 401 ? 'authentication' : res.status === 403 ? 'permission' : 'gateway')
  }

  private async connect(): Promise<void> {
    if (this.stopping) return
    const controller = this.controller
    this.setAccepting(true)
    this.reportState('connecting')
    const gatewayUrl = await this.getGatewayUrl()
    if (this.stopping || this.controller !== controller) return

    const ws = new WebSocket(gatewayUrl, { dispatcher: getGlobalDispatcher() })
    this.ws = ws

    this.ws.onopen = this.bindCallback(() => {
      console.debug('WebSocket connected')
    })

    this.ws.onmessage = this.bindCallback((event: MessageEvent) => {
      if (this.stopping || this.ws !== ws) return
      let data: {
        op: number
        d: Record<string, unknown> | null
        s: number | null
        t: string | null
      }
      try {
        data = JSON.parse(String(event.data))
      } catch {
        this.reportState('error')
        console.warn('[discord] Invalid gateway message')
        return
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
          this.heartbeatAcknowledged = true
          break
        case 7: // Reconnect
          console.info('Gateway requested reconnect')
          this.ws?.close()
          break
        case 9: // Invalid Session
          this.integration?.invalidate()
          this.setAccepting(false)
          console.warn('Invalid session, re-identifying after delay')
          this.sessionId = null
          this.reportState('connecting')
          clearTimeout(this.identifyTimer)
          this.identifyTimer = setTimeout(() => {
            if (!this.stopping && this.ws === ws) this.identify()
          }, 2000)
          break
        case 0: // Dispatch
          this.withConnection(() => this.handleDispatch(data.t!, data.d!)).catch((err) =>
            console.error('[discord] Incoming message handling failed')
          )
          break
      }
    })

    this.ws.onclose = this.bindCallback((event: CloseEvent) => {
      if (this.stopping || this.ws !== ws) return
      this.ws = null
      this.setAccepting(false)
      this.integration?.invalidate()
      this.reportState('disconnected')
      clearTimeout(this.identifyTimer)
      console.warn(
        `Discord WebSocket closed: code=${event.code}`,
      )
      if (this.heartbeatTimer) {
        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
      }
      if ([4004, 4010, 4011, 4013, 4014].includes(event.code)) {
        this.reportState('error')
        return
      }
      this.scheduleReconnect()
    })

    this.ws.onerror = this.bindCallback(() => {
      if (this.stopping || this.ws !== ws) return
      this.reportState('error')
      console.error('[discord] WebSocket error')
    })
  }

  private scheduleReconnect(): void {
    if (this.stopping || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.stopping) return
      void this.connect().catch(() => {
        if (this.stopping) return
        this.reportState('error')
        console.error('[discord] Reconnect failed')
        this.scheduleReconnect()
      })
    }, 5000)
  }

  private identify(): void {
    try {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      this.ws.send(JSON.stringify({
        op: 2,
        d: {
          token: this.token,
          intents: (1 << 0) | (1 << 9) | (1 << 12) | (1 << 15) | (this.memberIntent ? 1 << 1 : 0),
          properties: { os: 'node', browser: 'bot', device: 'bot' },
        },
      }))
    } catch {
      this.reportState('error')
      console.warn('[discord] Identify send failed')
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
          this.ws.send(JSON.stringify({ op: 1, d: this.seq }))
        }
      } catch (err) {
        this.reportState('error')
        console.warn('[discord] Heartbeat send failed')
      }
    }, intervalMs)
  }

  private async handleDispatch(
    event: string,
    data: Record<string, unknown>,
    processedRevision?: string,
    processedSignal?: AbortSignal,
  ): Promise<void> {
    if (['CHANNEL_UPDATE', 'CHANNEL_DELETE', 'GUILD_UPDATE', 'GUILD_DELETE', 'GUILD_ROLE_UPDATE', 'GUILD_ROLE_DELETE',
      'GUILD_MEMBER_UPDATE', 'GUILD_MEMBER_REMOVE', 'THREAD_UPDATE', 'THREAD_DELETE'].includes(event)) {
      this.capabilityCache.clear()
      this.channelNameCache.delete(String(data.id ?? ''))
      this.integration?.invalidate()
    }
    if (this.stopping) return
    if (/^(READY|RESUMED|GUILD_(CREATE|UPDATE|DELETE|ROLE_CREATE|ROLE_UPDATE|ROLE_DELETE|MEMBER_UPDATE)|CHANNEL_(CREATE|UPDATE|DELETE)|THREAD_(CREATE|UPDATE|DELETE))$/.test(event)) {
      this.capabilityCache.clear()
    }
    if (event === 'READY') {
      this.sessionId = data.session_id as string
      const user = data.user as Record<string, string>
      try {
        this.reportIdentity(user?.id ?? '')
      } catch {
        await this.stop()
        this.reportState('error')
        console.error('[discord] Bot identity is already bound or unavailable')
        return
      }
      this.reportState('connected')
      this.botUserId = user?.id ?? null
      const application = data.application as Record<string, unknown> | undefined
      this.applicationId = isDiscordId(application?.id) && isDiscordId(user?.id)
        && (user as Record<string, unknown>)?.bot === true ? application.id : null
      console.info(
        `Discord ready: sessionId=${this.sessionId}, user=${user?.username}, botUserId=${this.botUserId}`,
      )
      return
    }
    if (event === 'RESUMED') {
      this.reportState('connected')
      return
    }
    if (event === 'INTERACTION_CREATE') {
      await this.handleInteraction(data)
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
      const isBot = !!(author as Record<string, unknown>).bot
      if (author.id === this.botUserId || isBot && !this.integration) return

      let observed = false
      if (processedRevision === undefined && this.integration?.observe) {
        const signal = AbortSignal.any([this.controller.signal,AbortSignal.timeout(2000)])
        const proofs = await awaitInputSignal(this.integration.observe(data,signal),signal)
        for (const proof of proofs) {
          if (author.id === proof.botUserId || isBot && !proof.policy.includeBots) continue
          observed = true
          await this.observationProcessor.accept({
            key:JSON.stringify([proof.scopeId,proof.revision,proof.guildId,author.id]),id:String(data.id),
            event:{type:'discord.MESSAGE_CREATE',data},item:{proof,data:structuredClone(data)},
            policy:proof.policy,signal:this.controller.signal,publish:this.observationPublisher,classify:signal=>this.classifyObservation(proof,data,signal),
          })
        }
      }
      const content = data.content as string
      const guildId = data.guild_id as string | undefined

      const member = data.member as Record<string, unknown> | undefined
      const nick = member?.nick as string | undefined
      const authorName = nick ??
        (author as Record<string, string> | undefined)?.global_name ??
        author?.username ??
        author?.id

      let silent = false
      const sessionId = this.logicalSessionId(data.channel_id as string)
      const preparationSignal = processedSignal ?? this.controller.signal
      const wait = <T>(pending: Promise<T>) => awaitInputSignal(pending, preparationSignal)
      const state = await wait(Promise.resolve(this.sessionManager?.getSessionState(sessionId)))
      if (!this.isAllowed(author.id)) return
      const admission = await wait(Promise.resolve(this.integration?.admit({
        chatId: data.channel_id as string, senderId: author.id, messageId: data.id as string,
      }, preparationSignal)).then(proof => {
        if (preparationSignal.aborted && proof) this.integration?.discard(proof.admissionId)
        return proof
      })).catch(error => { if (observed) return undefined; throw error })
      if (observed && this.integration && !admission) return
      let retainedAdmission = true
      try {
      preparationSignal.throwIfAborted()
      if (author.id === admission?.botUserId || isBot && !admission?.processor?.includeBots) {
        if (admission) this.integration?.discard(admission.admissionId)
        return
      }
      const sessionTriggerMode = admission?.trigger ?? state?.config?.triggerMode ?? this.triggerMode
      const approval = /^\/shadow-approve ([a-f0-9-]{36}) ([a-f0-9]{64})\s*$/i.exec(content)
      if (approval && this.integration && admission) {
        this.integration.discard(admission.admissionId)
        let confirmation = 'The reviewed configuration is applied.'
        try {
          await this.integration.confirm(data.channel_id as string, author.id, approval[1], approval[2], this.controller.signal)
        } catch {
          console.warn('[discord] Configuration approval was rejected or requires recovery.')
          confirmation = 'Approval could not be confirmed. Open the draft in Shadow to inspect its applied or recovery state, permissions, expiry, and conflicts.'
        }
        await this.presentDecisionText(data.channel_id as string, confirmation, data.id as string)
        return
      }

      if (processedRevision !== undefined && admission?.processorRevision !== processedRevision) {
        if (admission) this.integration?.discard(admission.admissionId)
        return
      }
      if (isBot && processedRevision === undefined && admission?.processor?.includeBots) {
        const key = JSON.stringify([sessionId, author.id])
        const now = Date.now()
        for (const [id, until] of this.botProcessorCooldowns) if (until <= now) this.botProcessorCooldowns.delete(id)
        if (this.botProcessorCooldowns.has(key) || this.botProcessorCooldowns.size >= 1000) {
          this.integration?.discard(admission.admissionId)
          return
        }
        // Explicit bot opt-in is not permission for an unbounded inter-bot reply loop.
        this.botProcessorCooldowns.set(key, now + 60_000)
      }
      if (admission?.processor && processedRevision === undefined && this.integration) {
        const integration = this.integration
        const revision = admission.processorRevision!
        integration.discard(admission.admissionId)
        retainedAdmission = false
        // Never mix sender authority or conversation/epoch in one wake. Raw data is untrusted.
        await this.inputProcessor.accept({
          key: JSON.stringify([sessionId, author.id, revision]), id: String(data.id),
          event: { type: 'discord.MESSAGE_CREATE', data }, item: structuredClone(data),
          policy: admission.processor, signal: this.controller.signal,
          publish: this.processedPublisher(revision),
        })
        return
      }

      // Apply trigger mode filter
      if (sessionTriggerMode === 'mention' && guildId) {
        // In a guild: only respond to @mentions or replies to the bot
        if (!this.shouldRespond(data)) silent = true
      }
      if (processedRevision !== undefined) silent = false
      // DMs (no guildId) always pass through

      // Add reaction to acknowledge receipt
      if (!silent && this.reactionEmoji) {
        this.addReaction(data.channel_id as string, data.id as string).catch((
          err,
        ) => console.warn('Failed to add reaction', errMsg(err)))
      }

      // Strip bot mention from content so the LLM sees clean text
      let cleaned = this.stripBotMention(content)

      // Download and cache attachments locally.
      const attachments = data.attachments as
        | Array<Record<string, unknown>>
        | undefined

      // Preserve audio as a file; transcription is an optional agent operation.
      const channelId = data.channel_id as string
      let media: string[] | undefined
      if (attachments?.length) {
        const results = await wait(Promise.all(
          attachments.map((a) =>
            this.downloadAttachment(a, this.logicalSessionId(channelId), preparationSignal)
          ),
        ))
        const uris = results.filter(Boolean) as string[]
        if (uris.length > 0) media = uris
        if (uris.length !== results.length) {
          cleaned = [cleaned, '[attachment unavailable: download failed]'].filter(Boolean).join('\n')
        }
      }

      const channelName = guildId
        ? admission?.location.name ?? await wait(this.resolveChannelName(channelId, preparationSignal))
        : authorName
      const parentChannelId = this.threadParentMap.get(channelId)

      if (parentChannelId && !state && !this.integration) {
        console.log(
          `Thread ${channelId} has parent ${parentChannelId}, building session for thread...`,
        )
        const sessionId = this.logicalSessionId(channelId)
        await this.sessionManager?.buildSession(sessionId, {
          id: this.logicalSessionId(parentChannelId),
        })
      }

      preparationSignal.throwIfAborted()
      await this.handleIncoming(
        author.id,
        channelId,
        cleaned,
        data.id as string,
        {
          chatName: channelName ?? undefined,
          isGroup: !!guildId,
          senderName: authorName,
          silent,
          channelAdmissionId: admission?.admissionId,
          channelLocation: admission?.location,
        },
        media,
      )
      } catch (error) {
        if (admission && retainedAdmission) this.integration?.discard(admission.admissionId)
        throw error
      }
    }
  }

  /**
   * Download a Discord attachment, cache it under the session's uploads dir,
   * and return the local relative path (e.g. "uploads/discord_123.png").
   */
  private async downloadAttachment(
    attachment: Record<string, unknown>,
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const url = attachment.url as string | undefined
    const filename = attachment.filename as string | undefined
    if (!url || !filename) return null

    try {
      const source = new URL(url)
      if (source.protocol !== 'https:' || !['cdn.discordapp.com', 'media.discordapp.net'].includes(source.hostname) ||
        !source.pathname.startsWith('/attachments/')) throw new Error('Unsupported Discord attachment source')
      const res = await this.request(url, { signal })
      if (!res.ok) {
        console.warn(
          `[discord] Failed to download attachment ${filename}: ${res.status}`,
        )
        return null
      }

      const buf = new Uint8Array(await res.arrayBuffer())

      const ext = extname(filename) || ''
      const saveName = `discord_${attachment.id ?? Date.now()}${ext}`
      this.assertConnection()
      signal?.throwIfAborted()
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
   * Add a reaction to a message.
   */
  private async addReaction(
    channelId: string,
    messageId: string,
  ): Promise<void> {
    const emoji = encodeURIComponent(this.reactionEmoji)
    const url =
      `${DISCORD_API}/channels/${channelId}/messages/${messageId}/reactions/${emoji}/@me`
    const res = await this.request(url, {
      method: 'PUT',
      headers: { Authorization: `Bot ${this.token}` },
    })
    if (!res.ok) {
      await res.body?.cancel()
      console.warn(`Failed to add reaction: status=${res.status}`)
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

  private async resolveChannelName(channelId: string, signal?: AbortSignal): Promise<string | null> {
    const cached = this.channelNameCache.get(channelId)
    if (cached) return cached

    try {
      const res = await this.request(`${DISCORD_API}/channels/${channelId}`, {
        headers: { Authorization: `Bot ${this.token}` }, signal,
      })
      if (!res.ok) {
        return null
      }

      const data = await res.json() as { name?: string }
      signal?.throwIfAborted()
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
