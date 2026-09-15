import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'

const IDENTITIES_DIR = 'memory/identities'
const INDEX_FILE = 'memory/identities/index.json'
const LINK_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const LINK_EXPIRES_MS = 10 * 60 * 1000

interface IdentityState {
  version: 2
  accounts: Record<string, string>
  accountChats: Record<string, string>
  accountAddresses: Record<string, ChannelAddress>
  pendingLinks: Record<string, PendingLink>
}

interface PendingLink {
  requesterAccount: string
  targetAccount: string
  createdAt: string
  expiresAt: string
  organizationId?: string
  targetAddress?: ChannelAddress
  requesterAddress?: ChannelAddress
}

const addressSchema = z.object({
  organizationId: z.string().min(1),
  botInstanceId: z.string().min(1),
  platform: z.string().min(1),
  conversationId: z.string().min(1),
  legacySessionId: z.boolean().optional(),
})
const stateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]).optional(),
  accounts: z.record(z.string(), z.string()).default({}),
  accountChats: z.record(z.string(), z.string()).default({}),
  accountAddresses: z.record(z.string(), addressSchema).default({}),
  pendingLinks: z.record(z.string(), z.object({
    requesterAccount: z.string().min(1),
    targetAccount: z.string().min(1),
    createdAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    organizationId: z.string().min(1).optional(),
    requesterAddress: addressSchema.optional(),
    targetAddress: addressSchema.optional(),
  })).default({}),
})

export interface IdentityLinkOptions {
  organizationId?: string
  requesterAddress?: ChannelAddress
  /** Optional disambiguation among observed accounts; never an arbitrary destination. */
  targetBotInstanceId?: string
}

export interface IdentityLookupResult {
  personContext: string
}

export interface IdentityAssignResult {
  profileName: string
  profilePath: string
  accountKey: string
}

export interface IdentityLinkChallengeResult {
  code: string
  targetChannel: string
  targetChatId: string | null
  targetSenderId: string
  requesterProfileName: string
  expiresAt: string
  targetAddress?: ChannelAddress
}

export interface IdentityConfirmLinkResult {
  requesterAccountKey: string
  targetAccountKey: string
  profileName: string
}

export class IdentityManager {
  private workspace: string
  private identitiesDir: string
  private indexPath: string
  private state: IdentityState | null = null
  private operations: Promise<unknown> = Promise.resolve()

  constructor(workspace: string, private readonly organizationId?: string) {
    this.workspace = workspace
    this.identitiesDir = workspacePath(workspace, IDENTITIES_DIR)
    this.indexPath = workspacePath(workspace, INDEX_FILE)
  }

  async lookupByAccount(
    channel: string,
    senderId: string,
    address?: ChannelAddress,
  ): Promise<IdentityLookupResult> {
    return this.withState(async state => {
      const accountKey = this.accountKey(channel, senderId, address)
      const profileName = state.accounts[accountKey]

      if (!profileName) {
        return {
          personContext: [
            'System notice: this looks like a new user. No profile found.',
            'If they mention memories from other channels or old chats, ask whether they are using another account and guide them to run `userlink verify <channel> <senderId> [botInstanceId]` from this channel. The target must have sent a message first; confirmation must use that target bot and conversation.',
          ].join('\n'),
        }
      }

      const safeName = this.sanitizeProfileName(profileName)
      const profilePath = this.profilePathFor(safeName)
      return {
        personContext: [
          `System found user profile for ${safeName}.`,
          `Profile path: ${profilePath}`,
          'Use this profile for memory continuity and update it when you learn stable personal traits.',
        ].join('\n'),
      }
    })
  }

  async assignProfile(
    channel: string,
    senderId: string,
    profileName: string,
    chatId?: string,
    address?: ChannelAddress,
  ): Promise<IdentityAssignResult> {
    return this.withState(async state => {
      const safeName = this.sanitizeProfileName(profileName)
      const accountKey = this.accountKey(channel, senderId, address)
      if (address && chatId && address.conversationId !== chatId) throw new Error('Identity chat address mismatch')

      state.accounts[accountKey] = safeName
      if (chatId) {
        state.accountChats[accountKey] = String(chatId)
      }
      if (address) {
        state.accountAddresses[accountKey] = { ...address }
        state.accountChats[accountKey] = address.conversationId
      }
      await this.flushState(state)
      await this.ensureProfileFile(safeName)

      return {
        profileName: safeName,
        profilePath: this.profilePathFor(safeName),
        accountKey,
      }
    })
  }

  async observeInboundAccount(
    channel: string,
    senderId: string,
    chatId: string,
    displayName?: string,
    address?: ChannelAddress,
  ): Promise<IdentityAssignResult | null> {
    return this.withState(async state => {
      const accountKey = this.accountKey(channel, senderId, address)
      if (address && address.conversationId !== chatId) throw new Error('Identity chat address mismatch')

      state.accountChats[accountKey] = chatId
      if (address) state.accountAddresses[accountKey] = { ...address }

      if (state.accounts[accountKey]) {
        await this.flushState(state)
        return null
      }

      const inferred = this.inferProfileName(
        state,
        accountKey,
        displayName,
        channel,
        senderId,
      )
      state.accounts[accountKey] = inferred
      await this.flushState(state)
      await this.ensureProfileFile(inferred)

      return {
        profileName: inferred,
        profilePath: this.profilePathFor(inferred),
        accountKey,
      }
    })
  }

  /** Pin the observed target address; later activity must not retarget a pending challenge. */
  async createLinkChallenge(
    requesterChannel: string,
    requesterSenderId: string,
    targetChannel: string,
    targetSenderId: string,
    options: IdentityLinkOptions = {},
  ): Promise<IdentityLinkChallengeResult> {
    return this.withState(async state => {
      const organizationId = options.organizationId ?? options.requesterAddress?.organizationId ?? this.organizationId
      if (this.organizationId && organizationId !== this.organizationId) throw new Error('Identity organization mismatch')
      if (options.requesterAddress && options.requesterAddress.organizationId !== organizationId) throw new Error('Identity organization mismatch')
      if (organizationId && organizationId !== 'default' && !options.requesterAddress) {
        throw new Error('Source bot address is unavailable')
      }
      const requesterAccount = this.accountKey(
        requesterChannel,
        requesterSenderId,
        options.requesterAddress,
      )
      const candidates = Object.entries(state.accountAddresses).filter(([key, address]) =>
        address.organizationId === organizationId && address.platform === targetChannel
        && key === this.accountKey(targetChannel, targetSenderId, address)
        && (!options.targetBotInstanceId || address.botInstanceId === options.targetBotInstanceId))
      if (candidates.length > 1) throw new Error('Ambiguous target account; specify userlink verify <channel> <senderId> <botInstanceId>')
      const targetAddress = candidates[0]?.[1]
      const legacyRequester = !options.requesterAddress || options.requesterAddress.legacySessionId === true
      const legacyAllowed = (!organizationId || organizationId === 'default') && legacyRequester && !options.targetBotInstanceId
      if (!targetAddress && !legacyAllowed) throw new Error('Target bot address is unavailable; ask that account to send a message on the intended bot first')
      const targetAccount = this.accountKey(targetChannel, targetSenderId, targetAddress)
      const targetChatId = targetAddress?.conversationId ?? state.accountChats[targetAccount] ?? null
      if (organizationId && !targetChatId) throw new Error('Target account has no known chat session; ask it to send a message first')

      const requesterProfile = state.accounts[requesterAccount] ??
        this.inferProfileName(
          state,
          requesterAccount,
          undefined,
          requesterChannel,
          requesterSenderId,
        )
      state.accounts[requesterAccount] = requesterProfile

      const code = this.generateLinkCode(state)
      const now = new Date()
      const expiresAt = new Date(now.getTime() + LINK_EXPIRES_MS).toISOString()

      state.pendingLinks[code] = {
        requesterAccount,
        targetAccount,
        createdAt: now.toISOString(),
        expiresAt,
        ...(organizationId ? { organizationId } : {}),
        ...(options.requesterAddress ? { requesterAddress: { ...options.requesterAddress } } : {}),
        ...(targetAddress ? { targetAddress: { ...targetAddress } } : {}),
      }

      await this.flushState(state)
      await this.ensureProfileFile(requesterProfile)

      return {
        code,
        targetChannel,
        targetChatId,
        targetSenderId,
        requesterProfileName: requesterProfile,
        expiresAt,
        ...(targetAddress ? { targetAddress: { ...targetAddress } } : {}),
      }
    })
  }

  async confirmLink(
    channel: string,
    senderId: string,
    code: string,
    address?: ChannelAddress,
    organizationId = address?.organizationId ?? this.organizationId,
  ): Promise<IdentityConfirmLinkResult> {
    return this.withState(async state => {
      const normalizedCode = code.trim().toUpperCase()
      if (this.organizationId && organizationId !== this.organizationId) throw new Error('Identity organization mismatch')
      if (address && address.organizationId !== organizationId) throw new Error('Identity organization mismatch')
      const pending = state.pendingLinks[normalizedCode]
      if (!pending) {
        throw new Error('Invalid confirmation code')
      }

      const now = Date.now()
      if (Date.parse(pending.expiresAt) <= now) {
        delete state.pendingLinks[normalizedCode]
        await this.flushState(state)
        throw new Error('Confirmation code expired')
      }

      if (pending.organizationId && pending.organizationId !== organizationId) throw new Error('Confirmation belongs to a different organization')
      if (pending.targetAddress) {
        if (!address || address.organizationId !== pending.targetAddress.organizationId
          || address.botInstanceId !== pending.targetAddress.botInstanceId
          || address.platform !== pending.targetAddress.platform
          || address.conversationId !== pending.targetAddress.conversationId) {
          throw new Error('Confirmation must arrive from the target bot and conversation')
        }
      } else if ((organizationId && organizationId !== 'default') || (address && !address.legacySessionId)) {
        throw new Error('Legacy confirmation has no authoritative target bot address; request a new challenge')
      }
      const currentAccount = this.accountKey(channel, senderId, address)
      if (currentAccount !== pending.targetAccount) {
        throw new Error('This code was issued for a different account')
      }

      const requesterProfile = state.accounts[pending.requesterAccount]
      const targetProfile = state.accounts[pending.targetAccount]

      const canonicalProfile = this.sanitizeProfileName(
        requesterProfile ??
        targetProfile ??
        'Unknown',
      )

      state.accounts[pending.requesterAccount] = canonicalProfile
      state.accounts[pending.targetAccount] = canonicalProfile
      delete state.pendingLinks[normalizedCode]

      await this.flushState(state)
      await this.ensureProfileFile(canonicalProfile)

      return {
        requesterAccountKey: pending.requesterAccount,
        targetAccountKey: pending.targetAccount,
        profileName: canonicalProfile,
      }
    })
  }

  private withState<T>(run: (state: IdentityState) => Promise<T>): Promise<T> {
    const operation = this.operations.then(async () => run(structuredClone(await this.loadState())))
    this.operations = operation.then(() => undefined, () => undefined)
    return operation
  }

  private async loadState(): Promise<IdentityState> {
    if (this.state) return this.state

    await mkdir(this.identitiesDir, { recursive: true })
    const raw = await readFileIfExists(this.indexPath)
    if (!raw?.trim()) {
      const state: IdentityState = {
        version: 2,
        accounts: {},
        accountChats: {},
        accountAddresses: {},
        pendingLinks: {},
      }
      await this.flushState(state)
      return state
    }

    const parsed = stateSchema.parse(JSON.parse(raw))
    for (const address of Object.values(parsed.accountAddresses)) this.validateAddress(address)
    for (const pending of Object.values(parsed.pendingLinks)) {
      if (pending.targetAddress) this.validateAddress(pending.targetAddress)
      if (pending.requesterAddress) this.validateAddress(pending.requesterAddress)
      if (this.organizationId && pending.organizationId && pending.organizationId !== this.organizationId) {
        throw new Error('Persisted identity challenge organization mismatch')
      }
    }
    this.state = { ...parsed, version: 2 }

    return this.state
  }

  private async flushState(state: IdentityState): Promise<void> {
    await mkdir(this.identitiesDir, { recursive: true })
    const temporary = `${this.indexPath}.${crypto.randomUUID()}.tmp`
    try {
      await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' })
      await rename(temporary, this.indexPath)
      this.state = state
    } finally {
      await rm(temporary, { force: true })
    }
  }

  private validateAddress(address: ChannelAddress): void {
    addressSchema.parse(address)
    if (this.organizationId && address.organizationId !== this.organizationId) throw new Error('Identity organization mismatch')
    if (address.legacySessionId && (address.organizationId !== 'default' || address.botInstanceId !== `legacy-${address.platform}`)) {
      throw new Error('Invalid legacy identity bot address')
    }
  }

  private accountKey(channel: string, senderId: string, address?: ChannelAddress): string {
    if (!address && this.organizationId && this.organizationId !== 'default' && ['qq', 'discord', 'feishu'].includes(channel)) {
      throw new Error('Source bot address is unavailable')
    }
    if (address) {
      this.validateAddress(address)
      if (address.platform !== channel) throw new Error('Identity platform address mismatch')
      return channelSessionId({ ...address, conversationId: senderId })
    }
    return `${channel}:${senderId}`
  }

  private profilePathFor(profileName: string): string {
    return `memory/identities/${profileName}.md`
  }

  private inferProfileName(
    state: IdentityState,
    accountKey: string,
    displayName: string | undefined,
    channel: string,
    senderId: string,
  ): string {
    const baseName = this.sanitizeProfileName(
      displayName?.trim() || `User ${senderId.slice(-4)}`,
    )
    const usedByOthers = Object.entries(state.accounts).some(
      ([key, profile]) => key !== accountKey && profile === baseName,
    )

    if (!usedByOthers) return baseName

    const suffix = this.sanitizeProfileName(`${channel}-${senderId.slice(-6)}`)
      .replace(/\s+/g, '-')
    const used = new Set(Object.entries(state.accounts).filter(([key]) => key !== accountKey).map(([, profile]) => profile))
    const candidate = this.sanitizeProfileName(`${baseName}-${suffix}`)
    let name = candidate
    for (let index = 2; used.has(name); index++) name = `${candidate}-${index}`
    return name
  }

  private async ensureProfileFile(profileName: string): Promise<void> {
    const relativePath = this.profilePathFor(profileName)
    const absolutePath = workspacePath(this.workspace, relativePath)
    const existing = await readFileIfExists(absolutePath)
    if (existing?.trim()) return

    const content = [
      `# ${profileName}`,
      '',
      '## Top of Mind',
      '',
      '## Preferences',
      '',
      '## Facts',
      '',
    ].join('\n')

    await writeFile(absolutePath, content)
  }

  private generateLinkCode(state: IdentityState): string {
    let code = ''
    do {
      const bytes = new Uint8Array(6)
      crypto.getRandomValues(bytes)
      code = Array.from(bytes).map((b) =>
        LINK_CODE_CHARS[b % LINK_CODE_CHARS.length]
      ).join('')
    } while (state.pendingLinks[code])
    return code
  }

  private sanitizeProfileName(raw: string): string {
    const normalized = raw.normalize('NFKC').trim()
    const withoutControl = normalized.replace(/[\u0000-\u001F\u007F]/g, '')
    const withoutFileUnsafe = withoutControl.replace(/[<>:"/\\|?*]/g, '')
    const compact = withoutFileUnsafe.replace(/\s+/g, ' ').trim()
    const noTrailingDotsOrSpaces = compact.replace(/[. ]+$/g, '')

    if (
      !noTrailingDotsOrSpaces || noTrailingDotsOrSpaces === '.' ||
      noTrailingDotsOrSpaces === '..'
    ) {
      return 'Unknown'
    }

    return noTrailingDotsOrSpaces
  }
}
