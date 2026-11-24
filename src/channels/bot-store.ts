import { parseConnectionConfig } from './connection-config.ts'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { type Config } from '../config/schema.ts'
import { REDACTED_SECRET, writePrivateFile } from '../config/store.ts'
import { CHANNEL_IDS, type BotInstanceStatus, type ChannelId, type ChannelState } from './setup-contract.ts'
import { channelConfigured, channelPatchSchemas, channelSetupStatus, ChannelSetupError, secretFields } from './setup.ts'

const recordSchema = z.object({
  id: z.string().min(1).max(128),
  projectId: z.string().min(1),
  platform: z.enum(CHANNEL_IDS),
  displayName: z.string().trim().min(1).max(100),
  config: z.record(z.unknown()),
}).strict()
const documentSchema = z.object({ version: z.literal(4), bots: z.array(recordSchema) }).strict()

export interface BotInstance {
  id: string
  projectId: string
  platform: ChannelId
  displayName: string
  enabled: boolean
  config: NonNullable<Config['channels'][ChannelId]>
}

export interface BotInstanceStoreOptions {
  projectId: string
  changed?: () => void
  path: string
}

/**
 * One private config document per project. Callers supply the path explicitly.
 */
export class BotInstanceStore {
  readonly projectId: string
  readonly legacyConnectionsDetected: boolean
  private readonly storagePath: string
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
    this.storagePath = options.path
    let raw: unknown = existsSync(options.path) ? JSON.parse(readFileSync(options.path, 'utf8')) : undefined
    this.legacyConnectionsDetected = false
    if ((raw as { version?: unknown })?.version === 3) {
      const legacy = z.object({ version: z.literal(3), bots: z.array(z.unknown()) }).parse(raw)
      // Do not load legacy records, credentials, IDs, or permissions into the active store.
      this.storagePath = `${options.path}.v4`
      this.legacyConnectionsDetected = legacy.bots.length > 0
      if (this.legacyConnectionsDetected) {
        console.warn(`[connections] Project ${this.projectId}: legacy Connections were not imported. The original file is retained at ${options.path}. Recreate Connections in Settings and review and re-publish any needed BOT inbox bindings.`)
      }
      raw = existsSync(this.storagePath) ? JSON.parse(readFileSync(this.storagePath, 'utf8')) : undefined
    }
    if (raw !== undefined) {
      if ((raw as { version?: unknown })?.version !== 4) {
        throw new Error('Unsupported Connection document version; roleless Connections require version 4')
      }
      this.document = documentSchema.parse(raw)
    } else {
      this.document = { version: 4, bots: [] }
      mkdirSync(dirname(this.storagePath), { recursive: true })
      this.save(this.document)
    }
    const ids = new Set<string>()
    for (const bot of this.document.bots) {
      if (bot.projectId !== this.projectId || ids.has(bot.id)) throw new TypeError('Invalid bot ownership or duplicate ID')
      ids.add(bot.id)
      this.resolve(bot)
    }
  }

  private resolve(raw: z.infer<typeof recordSchema>): BotInstance {
    const config = parseConnectionConfig(raw.platform, raw.config) as BotInstance['config']
    return { ...raw, config, enabled: config.enabled }
  }

  /** Names only: status discovery must not resolve or expose every credential record. */
  ids(limit: number): { ids: string[]; truncated: boolean } {
    return { ids: this.document.bots.slice(0, limit).map(bot => bot.id).sort(), truncated: this.document.bots.length > limit }
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
      id: bot.id, projectId: bot.projectId, platform: bot.platform, displayName: bot.displayName,
    }
  }

  private patch(platform: ChannelId, input: Record<string, unknown>): Record<string, unknown> {
    const patch = { ...input }
    for (const field of secretFields[platform]) {
      if (patch[field] === REDACTED_SECRET || (typeof patch[field] === 'string' && !patch[field].trim())) delete patch[field]
    }
    const parsed = channelPatchSchemas[platform].safeParse(patch)
    if (!parsed.success) throw new ChannelSetupError('invalid_channel_config')
    const transport = { ...parsed.data }
    for (const key of ['allowFrom', 'adminChats', 'trustedChats', 'triggerMode']) if (Object.hasOwn(transport, key)) throw new ChannelSetupError('bot_policy_belongs_in_bot_package')
    return transport
  }

  private save(document: z.infer<typeof documentSchema>): void {
    const changed = JSON.stringify(document) !== JSON.stringify(this.document)
    writePrivateFile(this.storagePath, JSON.stringify(document, null, 2) + '\n')
    this.document = document
    if (changed) this.options.changed?.()
  }

  create(platform: ChannelId, displayName: string, config: Record<string, unknown>, signal?: AbortSignal): BotInstance {
    const raw = recordSchema.parse({
      id: randomUUID(), projectId: this.projectId, platform, displayName, config: this.patch(platform, config),
    })
    const bot = this.resolve(raw)
    this.validateEnabled(bot)
    signal?.throwIfAborted()
    this.save({ ...this.document, bots: [...this.document.bots, raw] })
    return bot
  }

  update(id: string, input: { displayName?: string; config?: Record<string, unknown> }, signal?: AbortSignal): BotInstance {
    const previous = this.document.bots.find(bot => bot.id === id)
    if (!previous) throw new ChannelSetupError('unknown_bot')
    const raw = recordSchema.parse({
      ...previous, ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
      config: { ...previous.config, ...this.patch(previous.platform, input.config ?? {}) },
    })
    const bot = this.resolve(raw)
    this.validateEnabled(bot)
    signal?.throwIfAborted()
    this.save({ ...this.document, bots: this.document.bots.map(entry => entry.id === id ? raw : entry) })
    return bot
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
