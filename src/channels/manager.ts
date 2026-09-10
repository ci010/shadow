import type { BaseChannel } from './base.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { Bus } from '../bus/bus.ts'
import type { Config } from '../config/schema.ts'
import type { Hono } from 'hono'
import type { SessionManager } from '../sessions/session-manager.ts'
import { DiscordChannel } from './discord.ts'
import { FeishuChannel } from './feishu.ts'
import { QQChannel } from './qq.ts'
import { WebChannel } from './web.ts'
import { WeChatChannel } from './wechat.ts'
import { SttClient, VoicePipeline } from '../voice/mod.ts'

/**
 * Initializes enabled channels and manages outbound message dispatch.
 */
export class ChannelManager {
  private channels = new Map<string, BaseChannel>()
  private running = false
  private voicePipeline?: VoicePipeline

  constructor(
    private config: Config,
    private bus: Bus,
    private sessionManager: SessionManager,
  ) { }

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

    if (ch.discord?.enabled) {
      const discord = new DiscordChannel(this.bus, {
        token: ch.discord.token ?? '',
        allowFrom: ch.discord.allowFrom,
        triggerMode: ch.discord.triggerMode,
        reactionEmoji: ch.discord.reactionEmoji,
        workspace: this.config.agent.workspace,
        adminChats: ch.discord.adminChats,
        sessionManager: this.sessionManager,
        voicePipeline: this.voicePipeline,
      })
      this.channels.set('discord', discord)
    }

    if (ch.feishu?.enabled) {
      const feishu = new FeishuChannel(this.bus, {
        appId: ch.feishu.appId ?? '',
        appSecret: ch.feishu.appSecret ?? '',
        encryptKey: ch.feishu.encryptKey,
        verificationToken: ch.feishu.verificationToken,
        allowFrom: ch.feishu.allowFrom,
        workspace: this.config.agent.workspace,
        adminChats: ch.feishu.adminChats,
        voicePipeline: this.voicePipeline,
      })
      this.channels.set('feishu', feishu)
    }

    if (ch.qq?.enabled) {
      const qq = new QQChannel(this.bus, {
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
      this.channels.set('qq', qq)
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

    console.info(
      `[channel-manager] Channels initialized: ${Array.from(this.channels.keys()).join(', ')
      }`,
    )
  }

  /**
   * Start all channels and the outbound dispatch loop.
   * Each channel receives the gateway Hono app to register its own routes.
   */
  async startAll(app: Hono): Promise<void> {
    this.running = true

    // Start outbound dispatcher
    this.dispatchOutbound()

    // Start each channel
    const starts = Array.from(this.channels.values()).map(async (ch) => {
      try {
        await ch.start(app)
        console.info(`[channel-manager] Channel started: ${ch.name}`)
      } catch (err) {
        console.error(
          `[channel-manager] Channel failed to start: ${ch.name}`,
          err,
        )
      }
    })

    await Promise.allSettled(starts)
  }

  /**
   * Stop all channels.
   */
  async stopAll(): Promise<void> {
    this.running = false
    for (const ch of this.channels.values()) {
      await ch.stop().catch(() => { })
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
    const ch = this.channels.get(channelName)
    if (!ch || !ch.createThread) return null
    return ch.createThread(parentChatId, name)
  }

  /**
   * Continuously consume outbound messages and route them to the correct channel.
   */
  private async dispatchOutbound(): Promise<void> {
    while (this.running) {
      try {
        const msg: OutboundMessage = await this.bus.consume('message.outbound')
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

        // Cleanup-only signal: done with no content, nothing to send
        if (msg.done && !msg.content) {
          continue
        }

        await ch.onMessage(msg)
      } catch (err) {
        console.error(
          '[channel-manager] Error dispatching outbound message',
          err,
        )
      }
    }
  }
}
