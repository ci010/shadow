import { ChannelAdmissionError, type BaseChannel, type ChannelDecision } from './base.ts'
import { unavailableCapabilities, type ChannelCapabilities } from './capabilities.ts'
import { YieldError } from '../sessions/yield.ts'
import { channelSessionId, type ChannelAddress, type OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { Config } from '../config/schema.ts'
import type { Hono } from 'hono'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { ReceiveChannelMessage } from '../sessions/input.ts'
import { DiscordChannel } from './discord.ts'
import { FeishuChannel } from './feishu.ts'
import { QQChannel } from './qq.ts'
import { WebChannel } from './web.ts'
import { WeChatChannel } from './wechat.ts'
import { SttClient, VoicePipeline } from '../voice/mod.ts'
import { CHANNEL_IDS, type BotInstanceStatus, type ChannelId, type ChannelSetupStatus, type ChannelState } from './setup-contract.ts'
import { channelConfigured, channelSetupStatus, ChannelSetupError, isChannelId } from './setup.ts'
import type { BotInstance, BotInstanceStore } from './bot-store.ts'
import { getOrganizationScope, type OrganizationScope } from '../organizations/scope.ts'

type ChannelFactory = (id: ChannelId, config: Config, instance?: BotInstance) => BaseChannel
export interface ChannelManagerOptions {
  organizationId: string
  instanceStore: BotInstanceStore
  factory?: ChannelFactory
  /** Defaults to the construction scope; the host closes it after channel shutdown. */
  scope?: OrganizationScope
}

// Host-wide ownership, not a routing registry. Failed cleanup retains its claim.
const platformOwners = new Map<string, BaseChannel>()
const scopedApps = new WeakMap<Hono, ChannelManager>()

/**
 * Initializes enabled channels and manages outbound message dispatch.
 */
export class ChannelManager {
  private channels = new Map<string, BaseChannel>()
  private running = false
  private voicePipeline?: VoicePipeline
  private dispatchController?: AbortController
  private dispatchTask?: Promise<void>
  private transportsStopping = false
  private app?: Hono
  private closing = false
  private operations: Promise<unknown> = Promise.resolve()
  private health = new Map<string, { state: ChannelState; message?: string }>()
  private cleanupFailed = new Set<string>()
  private shutdownTask?: Promise<void>
  private configRevision = 0
  private needsApply = new Set<string>()
  private readonly factory?: ChannelFactory
  private readonly options?: ChannelManagerOptions
  private readonly scope?: OrganizationScope
  readonly organizationId?: string

  constructor(
    private config: Config,
    private bus: Bus,
    private sessionManager: SessionManager,
    private receive: ReceiveChannelMessage,
    factoryOrOptions?: ChannelFactory | ChannelManagerOptions,
    options?: ChannelManagerOptions,
  ) {
    this.options = typeof factoryOrOptions === 'function' ? options : factoryOrOptions ?? options
    this.factory = typeof factoryOrOptions === 'function' ? factoryOrOptions : this.options?.factory
    this.organizationId = this.options?.organizationId
    this.scope = this.options?.scope ?? getOrganizationScope()
    if (this.options && this.scope && this.scope.organizationId !== this.organizationId) throw new TypeError('Channel manager organization scope mismatch')
    if (this.options && this.options.instanceStore.organizationId !== this.organizationId) throw new TypeError('Bot store ownership mismatch')
    this.bus.declareQueue('message.outbound')
  }

  private inScope<T>(operation: () => T): T {
    return this.scope ? this.scope.run(operation) : operation()
  }

  init(): Promise<void> {
    return this.inScope(() => this.initChannels())
  }

  private async initChannels(): Promise<void> {
    const ch = this.config.channels

    // Initialize voice pipeline if enabled
    if (this.config.voice?.enabled && this.config.voice.sttUrl) {
      const sttClient = new SttClient(
        this.config.voice.sttUrl,
        this.config.voice.timeoutMs,
      )
      this.voicePipeline = new VoicePipeline(
        sttClient,
        this.config.agent.workspace,
      )
      console.info(`[channel-manager] Voice pipeline enabled, STT URL: ${this.config.voice.sttUrl}`)
    }

    if (this.options) {
      for (const bot of this.options.instanceStore.list()) {
        if (bot.enabled && channelConfigured(bot.platform, { [bot.platform]: bot.config })) this.installBot(bot)
      }
    } else for (const id of CHANNEL_IDS) {
      if (ch[id]?.enabled && channelConfigured(id, ch)) this.install(id)
    }

    // Web channel is always enabled (serves as the browser/observer interface)
    {
      const web = new WebChannel(this.bus, {
        allowFrom: ch.web?.allowFrom,
        workspace: this.config.agent.workspace,
        sessionManager: this.sessionManager,
      })
      this.channels.set('web', web)
    }

    if (ch.wechat?.enabled && !this.options) {
      const wechat = new WeChatChannel(this.bus, {
        workspace: this.config.agent.workspace,
        allowFrom: ch.wechat.allowFrom,
      })
      this.channels.set('wechat', wechat)
    }

    for (const [key, channel] of this.channels) {
      if (!this.options || key === 'web') this.bindChannel(channel, key)
    }
    if (this.options && (ch.wechat?.enabled || ch.wechatDesktop?.enabled)) {
      console.warn('[channel-manager] Legacy WeChat adapters are unavailable in organization runtimes')
    }

    console.info(
      `[channel-manager] Channels initialized: ${Array.from(this.channels.keys()).join(', ')
      }`,
    )
  }

  private install(id: ChannelId): BaseChannel {
    const channel = this.factory?.(id, this.config) ?? this.createChannel(id)
    this.bindChannel(channel)
    channel.setStatusListener?.((state) => {
      if (this.channels.get(id) === channel && !this.needsApply.has(id)) this.health.set(id, {
        state,
        ...(state === 'running' ? { message: 'The platform SDK is running. It does not expose transport readiness; connection is not verified.' } : {}),
        ...(state === 'error' ? { message: 'Connection failed. Check credentials, platform permissions, and network access.' } : {}),
      })
    })
    this.channels.set(id, channel)
    return channel
  }

  private installBot(bot: BotInstance): BaseChannel {
    const config = { ...this.config, channels: { ...this.config.channels, [bot.platform]: bot.config } }
    const channel = this.factory?.(bot.platform, config, bot) ?? this.createChannel(bot.platform, config)
    if (channel.name !== bot.platform || !channel.setBotScope || (bot.platform === 'discord' && !channel.setIdentityHandler)) {
      throw new ChannelSetupError('bot_adapter_scope_unavailable', 503)
    }
    this.bindChannel(channel, bot.id, bot)
    let identityFailure: string | undefined
    channel.setIdentityHandler?.(identity => {
      if (this.channels.get(bot.id) !== channel || this.closing) throw new ChannelAdmissionError('Stale bot identity', 503)
      try {
        this.claimIdentity(channel, `${bot.platform}:actual:${identity}`)
      } catch (error) {
        identityFailure = error instanceof ChannelSetupError ? error.code : 'bot_identity_unavailable'
        throw error
      }
    })
    channel.setStatusListener?.(state => {
      if (this.channels.get(bot.id) === channel && !this.cleanupFailed.has(bot.id)) this.health.set(bot.id, {
        state: identityFailure ? 'error' : state,
        ...(identityFailure ? { message: identityFailure }
          : state === 'running' ? { message: 'The platform SDK is running; transport readiness is not verified.' } : {}),
      })
    })
    this.channels.set(bot.id, channel)
    return channel
  }

  private claimIdentity(channel: BaseChannel, identity: string): void {
    if (!identity.split(':').at(-1)) throw new ChannelSetupError('bot_identity_unavailable', 503)
    const owner = platformOwners.get(identity)
    if (owner && owner !== channel) throw new ChannelSetupError('bot_identity_already_bound', 503)
    platformOwners.set(identity, channel)
  }

  private releaseIdentity(channel: BaseChannel): void {
    for (const [identity, owner] of platformOwners) if (owner === channel) platformOwners.delete(identity)
  }

  botStatuses(): BotInstanceStatus[] {
    if (!this.options) throw new ChannelSetupError('bot_instances_unavailable', 503)
    return this.options.instanceStore.list().map(bot => this.options!.instanceStore.status(bot.id, this.health.get(bot.id)))
  }

  private botOperation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = this.operations.then(() => this.inScope(async () => {
      if (!this.options || this.closing) throw new ChannelSetupError('bot_instances_unavailable', 503)
      return operation()
    }))
    this.operations = pending.catch(() => {})
    return pending
  }

  createBot(input: { platform: ChannelId; displayName: string; config: Record<string, unknown> }, signal?: AbortSignal): Promise<BotInstanceStatus> {
    return this.botOperation(async () => {
      const bot = this.options!.instanceStore.create(input.platform, input.displayName, input.config, signal)
      if (bot.enabled) {
        const channel = this.installBot(bot)
        if (this.app) await this.startChannel(bot.id, channel)
      }
      return this.options!.instanceStore.status(bot.id, this.health.get(bot.id))
    })
  }

  updateBot(id: string, input: { displayName?: string; config?: Record<string, unknown> }, signal?: AbortSignal): Promise<BotInstanceStatus> {
    return this.botOperation(async () => {
      if (this.cleanupFailed.has(id)) throw new ChannelSetupError('channel_restart_required', 503)
      const bot = this.options!.instanceStore.update(id, input, signal)
      if (!await this.stopBot(id)) return this.options!.instanceStore.status(id, this.health.get(id))
      if (bot.enabled && !this.closing) {
        const channel = this.installBot(bot)
        if (this.app) await this.startChannel(id, channel)
      }
      return this.options!.instanceStore.status(id, this.health.get(id))
    })
  }

  deleteBot(id: string, signal?: AbortSignal): Promise<void> {
    return this.botOperation(async () => {
      this.options!.instanceStore.get(id)
      signal?.throwIfAborted()
      if (!await this.stopBot(id)) throw new ChannelSetupError('channel_restart_required', 503)
      this.options!.instanceStore.delete(id, signal)
    })
  }

  private async stopBot(id: string): Promise<boolean> {
    if (this.cleanupFailed.has(id)) return false
    const previous = this.channels.get(id)
    this.channels.delete(id)
    this.health.delete(id)
    if (!previous) return true
    try {
      await previous.stop()
      this.releaseIdentity(previous)
      return true
    } catch {
      this.channels.set(id, previous)
      this.cleanupFailed.add(id)
      previous.setStatusListener?.(() => {})
      this.health.set(id, { state: 'restart-required', message: 'The previous connection could not be stopped. Restart the backend before reconnecting.' })
      return false
    }
  }

  private bindChannel(channel: BaseChannel, key = channel.name, bot?: BotInstance): void {
    if (this.scope) channel.setOrganizationScope?.(this.scope)
    const scope = bot ? {
      organizationId: bot.organizationId, botInstanceId: bot.id, platform: bot.platform,
      ...(bot.legacySessionId ? { legacySessionId: true } : {}),
    } : undefined
    if (scope) channel.setBotScope?.(scope)
    channel.setReceiver(async message => {
      if (this.closing || this.channels.get(key) !== channel || this.cleanupFailed.has(key) || this.needsApply.has(key)) {
        throw new ChannelAdmissionError('The source bot connection is unavailable', 503)
      }
      if (bot && ['error', 'disconnected', 'restart-required'].includes(this.health.get(key)?.state ?? '')) {
        throw new ChannelAdmissionError('The source bot connection is unavailable', 503)
      }
      if (message.channel !== channel.name) throw new ChannelAdmissionError('Channel identity mismatch', 403)
      return this.receive({
        ...message, ...(scope ? { channelAddress: { ...scope, conversationId: message.chatId } } : {}),
      })
    })
    channel.setDecisionHandler?.(async decision => {
      if (this.closing || this.availableByKey(key) !== channel) throw new YieldError('unavailable', 'The channel connection has changed.')
      return this.answerDecision(channel, decision, scope ? { ...scope, conversationId: decision.chatId } : undefined)
    })
  }

  private resolveKey(name: string, address?: ChannelAddress): string | undefined {
    if (!this.options) return address ? undefined : name
    if (address) {
      if (address.organizationId !== this.organizationId || address.platform !== name) return undefined
      const bot = this.options.instanceStore.list().find(bot => bot.id === address.botInstanceId)
      return bot?.platform === name && !!bot.legacySessionId === !!address.legacySessionId ? bot.id : undefined
    }
    if (name === 'web' || name === 'virtual') return name
    return this.options.instanceStore.list().find(bot => bot.platform === name && bot.legacySessionId)?.id
  }

  private availableByKey(name: string): BaseChannel | undefined {
    if (this.transportsStopping) return undefined
    if (isChannelId(name) || (this.options && name !== 'web')) {
      if (this.cleanupFailed.has(name) || this.needsApply.has(name)) return undefined
      const state = this.health.get(name)?.state
      if (state !== 'connected' && state !== 'running') return undefined
    }
    return this.channels.get(name)
  }

  private availableChannel(name: string, address?: ChannelAddress): BaseChannel | undefined {
    const key = this.resolveKey(name, address)
    return key ? this.availableByKey(key) : undefined
  }

  async getCapabilities(name: string, chatId: string, address?: ChannelAddress): Promise<ChannelCapabilities> {
    if (address && address.conversationId !== chatId) return unavailableCapabilities()
    const channel = this.availableChannel(name, address)
    if (!channel?.getCapabilities) return unavailableCapabilities()
    try {
      const verify = channel.connectionGuard?.()
      const capabilities = await (channel.withConnection
        ? channel.withConnection(() => channel.getCapabilities!(chatId))
        : channel.getCapabilities(chatId))
      verify?.()
      if (this.availableChannel(name, address) !== channel) return unavailableCapabilities()
      return {
        ...capabilities,
        threads: channel.createThread ? capabilities.threads : 'none',
        decisions: channel.presentDecision || capabilities.decisions === 'native' ? capabilities.decisions : 'text',
      }
    } catch {
      console.warn(`[channel-manager] Could not resolve capabilities for ${name}`)
      return unavailableCapabilities()
    }
  }

  private async answerDecision(channel: BaseChannel, decision: ChannelDecision, address?: ChannelAddress): Promise<string> {
    if (!channel.isAllowed(decision.senderId)) throw new YieldError('forbidden', 'Sender is not authorized.')
    const sessionId = address ? channelSessionId(address) : `${channel.name}:${decision.chatId}`
    const request = this.sessionManager.yields.get(sessionId)
    if (!request || request.id !== decision.requestId) throw new YieldError('not_found', 'This question is no longer pending.')
    if (decision.option === 'cancel') {
      this.sessionManager.yields.cancelChannel(sessionId, request.id, channel.name, decision.senderId)
      this.sessionManager.getActiveSession(sessionId)?.cancel()
      return 'Question cancelled.'
    }
    if (![1, 2, 3].includes(decision.option)) throw new YieldError('invalid_request', 'Invalid choice.')
    const answer = this.sessionManager.yields.answerChannel(
      sessionId, request.id, request.options[decision.option - 1]!, channel.name, decision.senderId,
    )
    return `Selected: ${answer.option}`
  }

  async deliverDecision(msg: OutboundMessage): Promise<void> {
    const channel = this.availableChannel(msg.channel, msg.channelAddress)
    if (!channel) throw new YieldError('unavailable', 'Channel decision delivery is unavailable.')
    const verify = channel.connectionGuard?.()
    await (channel.withConnection ? channel.withConnection(() => this.deliverDecisionInConnection(msg))
      : this.deliverDecisionInConnection(msg))
    verify?.()
  }

  private async deliverDecisionInConnection(msg: OutboundMessage): Promise<void> {
    const request = msg.yieldRequest
    if (!request || request.sessionId !== (msg.channelAddress ? channelSessionId(msg.channelAddress) : `${msg.channel}:${msg.chatId}`)
      || (msg.channelAddress && msg.channelAddress.conversationId !== msg.chatId)) throw new YieldError('invalid_request', 'Invalid decision destination.')
    const channel = this.availableChannel(msg.channel, msg.channelAddress)
    if (!channel?.presentDecisionText) throw new YieldError('unavailable', 'Channel decision delivery is unavailable.')
    const capabilities = await this.getCapabilities(msg.channel, msg.chatId, msg.channelAddress)
    if (this.availableChannel(msg.channel, msg.channelAddress) !== channel) throw new YieldError('unavailable', 'The channel connection has changed.')
    if (this.sessionManager.yields.get(request.sessionId)?.id !== request.id) return
    if (capabilities.decisions === 'buttons' && channel.presentDecision) {
      try {
        await channel.presentDecision(msg.chatId, request, msg.content)
        return
      } catch {
        console.warn(`[channel-manager] Native decision delivery failed on ${msg.channel}; using text choices`)
      }
    }
    if (this.availableChannel(msg.channel, msg.channelAddress) !== channel) throw new YieldError('unavailable', 'The channel connection has changed.')
    if (this.sessionManager.yields.get(request.sessionId)?.id !== request.id) return
    await channel.presentDecisionText(msg.chatId, msg.content)
  }

  private createChannel(id: ChannelId, config = this.config): BaseChannel {
    const ch = {
      discord: config.channels.discord ?? { enabled: false, triggerMode: 'mention' as const, reactionEmoji: '👀' },
      feishu: config.channels.feishu ?? { enabled: false },
      qq: config.channels.qq ?? { enabled: false, sandbox: false, markdown: true },
    }
    if (id === 'discord') {
      return new DiscordChannel(this.bus, {
        token: ch.discord.token ?? '',
        allowFrom: ch.discord.allowFrom,
        triggerMode: ch.discord.triggerMode,
        reactionEmoji: ch.discord.reactionEmoji,
        workspace: this.config.agent.workspace,
        adminChats: ch.discord.adminChats,
        sessionManager: this.sessionManager,
        voicePipeline: this.voicePipeline,
      })
    }

    if (id === 'feishu') {
      return new FeishuChannel(this.bus, {
        appId: ch.feishu.appId ?? '',
        appSecret: ch.feishu.appSecret ?? '',
        encryptKey: ch.feishu.encryptKey,
        verificationToken: ch.feishu.verificationToken,
        sessionManager: this.sessionManager,
        allowFrom: ch.feishu.allowFrom,
        workspace: this.config.agent.workspace,
        adminChats: ch.feishu.adminChats,
        voicePipeline: this.voicePipeline,
      })
    }

    return new QQChannel(this.bus, {
      appId: ch.qq.appId ?? '',
      secret: ch.qq.secret ?? '',
      token: ch.qq.token,
      sandbox: ch.qq.sandbox,
      intents: ch.qq.intents,
      markdown: ch.qq.markdown,
      allowFrom: ch.qq.allowFrom,
      workspace: this.config.agent.workspace,
      adminChats: ch.qq.adminChats,
    })
  }

  status(id: ChannelId): ChannelSetupStatus {
    return channelSetupStatus(id, this.config.channels, this.health.get(id))
  }

  updateConfig(config: Config): void {
    if (this.options) {
      this.config = config
      return
    }
    this.configRevision++
    for (const id of CHANNEL_IDS) {
      if (JSON.stringify(this.config.channels[id]) !== JSON.stringify(config.channels[id])) {
        this.needsApply.add(id)
        this.health.set(id, {
          state: 'restart-required',
          message: 'Configuration changed outside channel setup. Save in Channels to apply it, or restart the backend.',
        })
      }
    }
    this.config = config
  }

  updateChannel(id: ChannelId, persist: (active: Config) => Promise<Config>): Promise<ChannelSetupStatus> {
    const operation = this.operations.then(async () => {
      if (this.closing) throw new ChannelSetupError('channels_stopping', 503)
      if (this.cleanupFailed.has(id)) throw new ChannelSetupError('channel_restart_required', 503)
      const revision = this.configRevision
      const saved = await persist(this.config)
      if (revision === this.configRevision) this.config = saved
      const previous = this.channels.get(id)
      if (previous) {
        this.channels.delete(id)
        try {
          await previous.stop()
        } catch {
          this.cleanupFailed.add(id)
          this.channels.set(id, previous)
          previous.setStatusListener?.(() => {})
          this.health.set(id, { state: 'restart-required', message: 'The previous connection could not be stopped. Restart the backend before reconnecting.' })
          return this.status(id)
        }
      }
      this.health.delete(id)
      this.needsApply.delete(id)
      if (this.config.channels[id]?.enabled && !this.closing && this.app) {
        await this.startChannel(id, this.install(id))
      }
      return this.status(id)
    })
    this.operations = operation.catch(() => {})
    return operation
  }

  private async startChannel(id: string, channel: BaseChannel): Promise<void> {
    this.health.set(id, { state: 'connecting' })
    try {
      if (this.options) {
        const bot = this.options.instanceStore.get(id)
        if (bot.platform !== 'discord') {
          const config: Record<string, unknown> = bot.config
          this.claimIdentity(channel, `${bot.platform}:app:${config.appId}`)
        }
      }
      await channel.start(this.app!)
      // Only transport callbacks can claim connection readiness.
      if (!channel.setStatusListener) this.health.set(id, { state: 'running' })
    } catch (error) {
      console.error(`[channel-manager] Channel failed to start: ${id}`)
      try {
        await channel.stop()
        this.releaseIdentity(channel)
        this.channels.delete(id)
        this.health.set(id, { state: 'error', message: error instanceof ChannelSetupError
          ? error.code : 'Connection failed. Check credentials, platform permissions, and network access.' })
      } catch {
        this.cleanupFailed.add(id)
        channel.setStatusListener?.(() => {})
        this.health.set(id, { state: 'restart-required', message: 'Connection cleanup failed. Restart the backend before reconnecting.' })
      }
    }
  }

  /**
   * Start all channels and the outbound dispatch loop.
   * Each channel receives the gateway Hono app to register its own routes.
   */
  startAll(app: Hono): Promise<void> {
    return this.inScope(() => this.startChannels(app))
  }

  private async startChannels(app: Hono): Promise<void> {
    if (this.running) return
    if (this.closing) throw new ChannelSetupError('channels_stopping', 503)
    if (this.options) {
      const owner = scopedApps.get(app)
      if (owner && owner !== this) throw new ChannelSetupError('bot_gateway_scope_already_bound', 503)
      scopedApps.set(app, this)
    }
    this.app = app
    FeishuChannel.registerRoutes(app, !!this.options)
    this.running = true

    // Start outbound dispatcher
    this.dispatchController = new AbortController()
    this.dispatchTask = this.dispatchOutbound(this.dispatchController.signal)

    // Start each channel
    const starts = Array.from(this.channels.entries()).map(async ([key, ch]) => {
      try {
        if (isChannelId(ch.name)) {
          await this.startChannel(key, ch)
          return
        }
        await ch.start(app)
        console.info(`[channel-manager] Channel started: ${ch.name}`)
      } catch (err) {
        console.error(
          `[channel-manager] Channel failed to start: ${ch.name}`,
          err,
        )
      }
    })

    this.operations = Promise.allSettled(starts)
    await this.operations
  }

  /**
   * After producers quiesce, drain outbound work before stopping channels.
   * Cancels an idle consume wait without cancelling in-flight sends.
   */
  stopAll(): Promise<void> {
    return this.shutdownTask ??= this.inScope(() => this.stopChannels())
  }

  beginShutdown(): void {
    this.closing = true
  }

  private async stopChannels(): Promise<void> {
    this.beginShutdown()
    await this.operations
    this.running = false
    this.dispatchController?.abort()
    await this.dispatchTask
    this.dispatchTask = undefined
    this.dispatchController = undefined
    this.transportsStopping = true
    for (const ch of this.channels.values()) {
      try {
        await ch.stop()
        this.releaseIdentity(ch)
      } catch {
        console.error(`[channel-manager] Channel cleanup failed: ${ch.name}`)
      }
    }
  }

  /**
   * Create a thread in the specified channel.
   * Returns null for unsupported threads or a missing legacy channel.
   * An explicitly addressed unavailable bot is an error, never a fallback.
   */
  async createThread(
    channelName: string,
    parentChatId: string,
    name: string,
    address?: ChannelAddress,
  ): Promise<string | null> {
    if (address && address.conversationId !== parentChatId) throw new YieldError('invalid_request', 'Invalid thread destination.')
    const ch = this.availableChannel(channelName, address)
    if (address && !ch) throw new YieldError('unavailable', 'The source bot is unavailable.')
    if (!ch || !ch.createThread) return null
    const verify = ch.connectionGuard?.()
    const capabilities = await this.getCapabilities(channelName, parentChatId, address)
    verify?.()
    if (this.availableChannel(channelName, address) !== ch) throw new YieldError('unavailable', 'The source bot connection has changed.')
    if (capabilities.threads === 'none') return null
    const thread = await (ch.withConnection ? ch.withConnection(() => ch.createThread!(parentChatId, name))
      : ch.createThread(parentChatId, name))
    verify?.()
    if (this.availableChannel(channelName, address) !== ch) throw new YieldError('unavailable', 'The source bot connection has changed.')
    return thread
  }

  async deliver(msg: OutboundMessage): Promise<void> {
    if (msg.channelAddress && msg.channelAddress.conversationId !== msg.chatId) throw new YieldError('invalid_request', 'Invalid bot destination.')
    const key = this.resolveKey(msg.channel, msg.channelAddress)
    const channel = key ? this.availableByKey(key) : undefined
    if (!channel) throw new YieldError('unavailable', 'The source bot is unavailable.')
    const verify = channel.connectionGuard?.()
    if (msg.yieldRequest) await this.deliverDecision(msg)
    else if (channel.withConnection) await channel.withConnection(() => channel.onMessage(msg))
    else await channel.onMessage(msg)
    verify?.()
  }

  /**
   * Continuously consume outbound messages and route them to the correct channel.
   */
  private async dispatchOutbound(signal: AbortSignal): Promise<void> {
    while (this.running || this.bus.hasQueued('message.outbound')) {
      let waiting = true
      let redactError = false
      try {
        const msg: OutboundMessage = await this.bus.consume(
          'message.outbound',
          this.running ? { signal } : undefined,
        )
        waiting = false
        if (this.options && msg.channel !== 'virtual') {
          try {
            await this.deliver(msg)
          } catch {
            console.error('[channel-manager] Source bot delivery unavailable')
            this.bus.emit('channel.delivery.failed', {
              organizationId: this.organizationId, channelAddress: msg.channelAddress,
              channel: msg.channel, chatId: msg.chatId, error: 'source_bot_unavailable',
            })
          }
          continue
        }
        redactError = isChannelId(msg.channel)
        if (isChannelId(msg.channel) && this.cleanupFailed.has(msg.channel)) {
          console.error(`[channel-manager] Channel requires restart before delivery: ${msg.channel}`)
          continue
        }
        // Once dequeued, finish delivery before stopping the channels. Do not
        // discard an in-flight message if stopAll() races with consume().
        const ch = this.channels.get(msg.channel)
        if (!ch) {
          // virtual channels are handled via bus.on('message.outbound')
          if (msg.channel !== 'virtual') {
            console.warn(
              `[channel-manager] No channel found for outbound message: ${msg.channel}`,
            )
          }
          continue
        }

        if (msg.yieldRequest) await this.deliverDecision(msg)
        else await ch.onMessage(msg)
      } catch (err) {
        if (waiting && (
          (signal.aborted && err === signal.reason) ||
          (err instanceof DOMException && err.name === 'AbortError')
        )) {
          if (this.running) break
          continue
        }
        console.error(
          '[channel-manager] Error dispatching outbound message',
          redactError ? new Error('Channel delivery failed') : err,
        )
      }
    }
  }
}
