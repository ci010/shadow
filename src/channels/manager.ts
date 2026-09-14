import type { BaseChannel, ChannelDecision } from './base.ts'
import { unavailableCapabilities, type ChannelCapabilities } from './capabilities.ts'
import { YieldError } from '../sessions/yield.ts'
import type { OutboundMessage } from '../bus/events.ts'
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
import { CHANNEL_IDS, type ChannelId, type ChannelSetupStatus, type ChannelState } from './setup-contract.ts'
import { channelConfigured, channelSetupStatus, ChannelSetupError, isChannelId } from './setup.ts'

/**
 * Initializes enabled channels and manages outbound message dispatch.
 */
export class ChannelManager {
  private channels = new Map<string, BaseChannel>()
  private running = false
  private voicePipeline?: VoicePipeline
  private dispatchController?: AbortController
  private dispatchTask?: Promise<void>
  private app?: Hono
  private closing = false
  private operations: Promise<unknown> = Promise.resolve()
  private health = new Map<ChannelId, { state: ChannelState; message?: string }>()
  private cleanupFailed = new Set<ChannelId>()
  private shutdownTask?: Promise<void>
  private configRevision = 0
  private needsApply = new Set<ChannelId>()

  constructor(
    private config: Config,
    private bus: Bus,
    private sessionManager: SessionManager,
    private receive: ReceiveChannelMessage,
    private readonly factory?: (id: ChannelId, config: Config) => BaseChannel,
  ) {
    this.bus.declareQueue('message.outbound')
  }

  async init(): Promise<void> {
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

    for (const id of CHANNEL_IDS) {
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

    if (ch.wechat?.enabled) {
      const wechat = new WeChatChannel(this.bus, {
        workspace: this.config.agent.workspace,
        allowFrom: ch.wechat.allowFrom,
      })
      this.channels.set('wechat', wechat)
    }

    for (const channel of this.channels.values()) this.bindChannel(channel)

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

  private bindChannel(channel: BaseChannel): void {
    channel.setReceiver(this.receive)
    channel.setDecisionHandler?.(async decision => {
      if (this.availableChannel(channel.name) !== channel) throw new YieldError('unavailable', 'The channel connection has changed.')
      return this.answerDecision(channel, decision)
    })
  }

  private availableChannel(name: string): BaseChannel | undefined {
    if (this.closing) return undefined
    if (isChannelId(name)) {
      if (this.cleanupFailed.has(name) || this.needsApply.has(name)) return undefined
      const state = this.health.get(name)?.state
      if (state !== 'connected' && state !== 'running') return undefined
    }
    return this.channels.get(name)
  }

  async getCapabilities(name: string, chatId: string): Promise<ChannelCapabilities> {
    const channel = this.availableChannel(name)
    if (!channel?.getCapabilities) return unavailableCapabilities()
    try {
      const capabilities = await channel.getCapabilities(chatId)
      if (this.availableChannel(name) !== channel) return unavailableCapabilities()
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

  private async answerDecision(channel: BaseChannel, decision: ChannelDecision): Promise<string> {
    if (!channel.isAllowed(decision.senderId)) throw new YieldError('forbidden', 'Sender is not authorized.')
    const sessionId = `${channel.name}:${decision.chatId}`
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
    const request = msg.yieldRequest
    if (!request || request.sessionId !== `${msg.channel}:${msg.chatId}`) throw new YieldError('invalid_request', 'Invalid decision destination.')
    const channel = this.availableChannel(msg.channel)
    if (!channel?.presentDecisionText) throw new YieldError('unavailable', 'Channel decision delivery is unavailable.')
    const capabilities = await this.getCapabilities(msg.channel, msg.chatId)
    if (this.availableChannel(msg.channel) !== channel) throw new YieldError('unavailable', 'The channel connection has changed.')
    if (this.sessionManager.yields.get(request.sessionId)?.id !== request.id) return
    if (capabilities.decisions === 'buttons' && channel.presentDecision) {
      try {
        await channel.presentDecision(msg.chatId, request, msg.content)
        return
      } catch {
        console.warn(`[channel-manager] Native decision delivery failed on ${msg.channel}; using text choices`)
      }
    }
    if (this.availableChannel(msg.channel) !== channel) throw new YieldError('unavailable', 'The channel connection has changed.')
    if (this.sessionManager.yields.get(request.sessionId)?.id !== request.id) return
    await channel.presentDecisionText(msg.chatId, msg.content)
  }

  private createChannel(id: ChannelId): BaseChannel {
    const ch = {
      discord: this.config.channels.discord ?? { enabled: false, triggerMode: 'mention' as const, reactionEmoji: '👀' },
      feishu: this.config.channels.feishu ?? { enabled: false },
      qq: this.config.channels.qq ?? { enabled: false, sandbox: false, markdown: true },
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

  private async startChannel(id: ChannelId, channel: BaseChannel): Promise<void> {
    this.health.set(id, { state: 'connecting' })
    try {
      await channel.start(this.app!)
      // Only transport callbacks can claim connection readiness.
      if (!channel.setStatusListener) this.health.set(id, { state: 'running' })
    } catch {
      console.error(`[channel-manager] Channel failed to start: ${id}`)
      try {
        await channel.stop()
        this.channels.delete(id)
        this.health.set(id, { state: 'error', message: 'Connection failed. Check credentials, platform permissions, and network access.' })
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
  async startAll(app: Hono): Promise<void> {
    if (this.running) return
    if (this.closing) throw new ChannelSetupError('channels_stopping', 503)
    this.app = app
    FeishuChannel.registerRoutes(app)
    this.running = true

    // Start outbound dispatcher
    this.dispatchController = new AbortController()
    this.dispatchTask = this.dispatchOutbound(this.dispatchController.signal)

    // Start each channel
    const starts = Array.from(this.channels.values()).map(async (ch) => {
      try {
        if (isChannelId(ch.name)) {
          await this.startChannel(ch.name, ch)
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
    return this.shutdownTask ??= this.stopChannels()
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
    for (const ch of this.channels.values()) {
      try {
        await ch.stop()
      } catch {
        console.error(`[channel-manager] Channel cleanup failed: ${ch.name}`)
      }
    }
  }

  /**
   * Create a thread in the specified channel.
   * Returns null if the channel doesn't exist or doesn't support threads.
   */
  async createThread(
    channelName: string,
    parentChatId: string,
    name: string,
  ): Promise<string | null> {
    const ch = this.availableChannel(channelName)
    if (!ch || !ch.createThread) return null
    if ((await this.getCapabilities(channelName, parentChatId)).threads === 'none') return null
    if (this.availableChannel(channelName) !== ch) return null
    return ch.createThread(parentChatId, name)
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
