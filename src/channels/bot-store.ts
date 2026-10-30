import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ChannelsSchema, type Config } from '../config/schema.ts'
import { REDACTED_SECRET, writePrivateFile } from '../config/store.ts'
import { CHANNEL_IDS, type BotInstanceStatus, type ChannelId, type ChannelState } from './setup-contract.ts'
import { channelConfigured, channelPatchSchemas, channelSetupStatus, ChannelSetupError, secretFields } from './setup.ts'

const recordSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1),
  platform: z.enum(CHANNEL_IDS),
  displayName: z.string().trim().min(1).max(100),
  config: z.record(z.unknown()),
  legacySessionId: z.literal(true).optional(),
  purpose: z.enum(['personal', 'service', 'legacy']).default('legacy'),
  verifiedOwner: z.object({ senderId: z.string().min(1), chatId: z.string().min(1), verifiedAt: z.string() }).strict().optional(),
}).strict()
const documentSchema = z.object({ version: z.literal(2), bots: z.array(recordSchema) }).strict()

export interface BotInstance {
  id: string
  projectId: string
  platform: ChannelId
  displayName: string
  enabled: boolean
  purpose: 'personal' | 'service' | 'legacy'
  verifiedOwner?: { senderId: string; chatId: string; verifiedAt: string }
  config: NonNullable<Config['channels'][ChannelId]>
  legacySessionId?: true
}

export interface BotInstanceStoreOptions {
  projectId: string
  changed?: () => void
  path: string
  /** Explicitly supply only for the default project; never read environment here. */
  legacyConfig?: Config
  /** Original serialized channels, excluding effective environment credentials. */
  legacyRawChannels?: Config['channels']
}

/**
 * One private config document per project. Callers supply the path explicitly.
 * Legacy migration is create-once; deleting a migrated instance never recreates it.
 * Effective environment credentials are overlaid only in memory for legacy records.
 */
export class BotInstanceStore {
  readonly projectId: string
  private document: z.infer<typeof documentSchema>
  private accessChanges = new Map<string, { active: number; revision: number }>()

  /** Transient only: shared by adapter and session admission, never persisted. */
  beginAccessChange(id: string): () => void {
    this.get(id)
    const state = this.accessChanges.get(id) ?? { active: 0, revision: 0 }
    state.active++
    state.revision++
    this.accessChanges.set(id, state)
    let released = false
    return () => { if (!released) { released = true; state.active-- } }
  }

  assertAccess(id: string): void {
    if (this.accessChanges.get(id)?.active) throw new Error('Bot access change in progress')
  }

  accessGuard(id: string): () => void {
    this.assertAccess(id)
    const revision = this.accessChanges.get(id)?.revision ?? 0
    return () => {
      this.assertAccess(id)
      if ((this.accessChanges.get(id)?.revision ?? 0) !== revision) throw new Error('Bot access changed')
    }
  }

  constructor(private readonly options: BotInstanceStoreOptions) {
    this.projectId = options.projectId
    if (!this.projectId) throw new TypeError('Project ID is required')
    if (existsSync(options.path)) {
      const raw: unknown = JSON.parse(readFileSync(options.path, 'utf8'))
      this.document = documentSchema.parse(raw)
    } else {
      this.document = {
        version: 2,
        bots: options.legacyConfig ? CHANNEL_IDS.filter(platform => platform !== 'wechat' &&
          options.legacyConfig?.channels[platform] !== undefined || options.legacyRawChannels?.[platform] !== undefined
        ).map(platform => ({
          purpose: 'legacy' as const, id: `legacy-${platform}`, projectId: this.projectId, platform,
          displayName: `${platform === 'qq' ? 'QQ' : platform === 'discord' ? 'Discord' : 'Feishu'} bot`,
          legacySessionId: true as const,
          config: { ...options.legacyRawChannels?.[platform] },
        })) : [],
      }
      mkdirSync(dirname(options.path), { recursive: true })
      this.save(this.document)
    }
    const ids = new Set<string>()
    for (const bot of this.document.bots) {
      if (bot.projectId !== this.projectId || ids.has(bot.id)) throw new TypeError('Invalid bot ownership or duplicate ID')
      if (bot.legacySessionId && (!options.legacyConfig || bot.id !== `legacy-${bot.platform}`)) {
        throw new TypeError('Legacy bot identities are restricted to the default project')
      }
      ids.add(bot.id)
      this.resolve(bot)
    }
  }

  private resolve(raw: z.infer<typeof recordSchema>): BotInstance {
    if (raw.platform === 'wechat' && raw.purpose !== 'personal') throw new ChannelSetupError('wechat_personal_bot_required')
    const inherited = raw.legacySessionId ? this.options.legacyConfig?.channels[raw.platform] : undefined
    const config = ChannelsSchema.parse({ [raw.platform]: { ...inherited, ...raw.config } })[raw.platform]!
    return { ...raw, config, enabled: config.enabled }
  }

  list(): BotInstance[] { return this.document.bots.map(bot => this.resolve(bot)) }
  get(id: string): BotInstance {
    const raw = this.document.bots.find(bot => bot.id === id)
    if (!raw) throw new ChannelSetupError('unknown_bot')
    return this.resolve(raw)
  }

  status(id: string, health?: { state: ChannelState; message?: string }): BotInstanceStatus {
    const bot = this.get(id)
    return {
      ...channelSetupStatus(bot.platform, { [bot.platform]: bot.config }, health),
      purpose: bot.purpose, ownerVerified: !!bot.verifiedOwner, id: bot.id, projectId: bot.projectId, platform: bot.platform, displayName: bot.displayName,
    }
  }

  private patch(platform: ChannelId, input: Record<string, unknown>): Record<string, unknown> {
    const patch = { ...input }
    for (const field of secretFields[platform]) {
      if (patch[field] === REDACTED_SECRET || (typeof patch[field] === 'string' && !patch[field].trim())) delete patch[field]
    }
    const parsed = channelPatchSchemas[platform].safeParse(patch)
    if (!parsed.success) throw new ChannelSetupError('invalid_channel_config')
    return parsed.data
  }

  private save(document: z.infer<typeof documentSchema>): void {
    const changed = JSON.stringify(document) !== JSON.stringify(this.document)
    writePrivateFile(this.options.path, JSON.stringify(document, null, 2) + '\n')
    this.document = document
    if (changed) this.options.changed?.()
  }

  create(platform: ChannelId, displayName: string, config: Record<string, unknown>, signal?: AbortSignal, purpose: 'personal' | 'service' = 'service'): BotInstance {
    const raw = recordSchema.parse({
      purpose, id: randomUUID(), projectId: this.projectId, platform, displayName, config: this.patch(platform, config),
    })
    const bot = this.resolve(raw)
    this.validateEnabled(bot)
    signal?.throwIfAborted()
    this.save({ ...this.document, bots: [...this.document.bots, raw] })
    return bot
  }

  update(id: string, input: { displayName?: string; config?: Record<string, unknown>; purpose?: 'personal' | 'service' }, signal?: AbortSignal): BotInstance {
    const previous = this.document.bots.find(bot => bot.id === id)
    if (!previous) throw new ChannelSetupError('unknown_bot')
    const raw = recordSchema.parse({
      ...previous, ...(input.purpose && input.purpose !== previous.purpose ? { purpose: input.purpose, verifiedOwner: undefined } : {}), ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      config: { ...previous.config, ...this.patch(previous.platform, input.config ?? {}) },
    })
    const bot = this.resolve(raw)
    this.validateEnabled(bot)
    signal?.throwIfAborted()
    this.save({ ...this.document, bots: this.document.bots.map(entry => entry.id === id ? raw : entry) })
    return bot
  }

  bindOwner(id: string, senderId?: string, chatId?: string): void {
    const previous = this.document.bots.find(bot => bot.id === id)
    if (!previous) throw new ChannelSetupError('unknown_bot')
    const raw = recordSchema.parse({ ...previous, verifiedOwner: senderId ? { senderId, chatId, verifiedAt: new Date().toISOString() } : undefined })
    this.save({ ...this.document, bots: this.document.bots.map(bot => bot.id === id ? raw : bot) })
  }

  delete(id: string, signal?: AbortSignal): void {
    this.get(id)
    signal?.throwIfAborted()
    this.save({ ...this.document, bots: this.document.bots.filter(bot => bot.id !== id) })
  }

  private validateEnabled(bot: BotInstance): void {
    if (bot.enabled && !channelConfigured(bot.platform, { [bot.platform]: bot.config })) {
      throw new ChannelSetupError('channel_credentials_required')
    }
  }
}
