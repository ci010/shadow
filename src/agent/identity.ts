import { mkdir, writeFile } from 'node:fs/promises'
import { readFileIfExists, workspacePath } from '../utils/paths.ts'

const IDENTITIES_DIR = 'memory/identities'
const INDEX_FILE = 'memory/identities/index.json'
const LINK_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const LINK_EXPIRES_MS = 10 * 60 * 1000

interface IdentityState {
  version: 2
  accounts: Record<string, string>
  accountChats: Record<string, string>
  pendingLinks: Record<string, PendingLink>
}

interface PendingLink {
  requesterAccount: string
  targetAccount: string
  createdAt: string
  expiresAt: string
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

  constructor(workspace: string) {
    this.workspace = workspace
    this.identitiesDir = workspacePath(workspace, IDENTITIES_DIR)
    this.indexPath = workspacePath(workspace, INDEX_FILE)
  }

  async lookupByAccount(
    channel: string,
    senderId: string,
  ): Promise<IdentityLookupResult> {
    const state = await this.loadState()
    const accountKey = this.accountKey(channel, senderId)
    const profileName = state.accounts[accountKey]

    if (!profileName) {
      return {
        personContext: [
          'System notice: this looks like a new user. No profile found.',
          'If they mention memories from other channels or old chats, ask whether they are using another account and guide them to run `userlink verify <channel> <senderId>` from this channel.',
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
  }

  async assignProfile(
    channel: string,
    senderId: string,
    profileName: string,
    chatId?: string,
  ): Promise<IdentityAssignResult> {
    const state = await this.loadState()
    const safeName = this.sanitizeProfileName(profileName)
    const accountKey = this.accountKey(channel, senderId)

    state.accounts[accountKey] = safeName
    if (chatId) {
      state.accountChats[accountKey] = String(chatId)
    }
    await this.flushState(state)
    await this.ensureProfileFile(safeName)

    return {
      profileName: safeName,
      profilePath: this.profilePathFor(safeName),
      accountKey,
    }
  }

  async observeInboundAccount(
    channel: string,
    senderId: string,
    chatId: string,
    displayName?: string,
  ): Promise<IdentityAssignResult | null> {
    const state = await this.loadState()
    const accountKey = this.accountKey(channel, senderId)

    state.accountChats[accountKey] = chatId

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
  }

  async createLinkChallenge(
    requesterChannel: string,
    requesterSenderId: string,
    targetChannel: string,
    targetSenderId: string,
  ): Promise<IdentityLinkChallengeResult> {
    const state = await this.loadState()
    const requesterAccount = this.accountKey(
      requesterChannel,
      requesterSenderId,
    )
    const targetAccount = this.accountKey(targetChannel, targetSenderId)

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
    }

    await this.flushState(state)
    await this.ensureProfileFile(requesterProfile)

    return {
      code,
      targetChannel,
      targetChatId: state.accountChats[targetAccount] ?? null,
      targetSenderId,
      requesterProfileName: requesterProfile,
      expiresAt,
    }
  }

  async confirmLink(
    channel: string,
    senderId: string,
    code: string,
  ): Promise<IdentityConfirmLinkResult> {
    const normalizedCode = code.trim().toUpperCase()
    const state = await this.loadState()
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

    const currentAccount = this.accountKey(channel, senderId)
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
  }

  private async loadState(): Promise<IdentityState> {
    if (this.state) return this.state

    await mkdir(this.identitiesDir, { recursive: true })
    const raw = await readFileIfExists(this.indexPath)
    if (!raw?.trim()) {
      this.state = {
        version: 2,
        accounts: {},
        accountChats: {},
        pendingLinks: {},
      }
      await this.flushState(this.state)
      return this.state
    }

    try {
      const parsed = JSON.parse(raw) as Partial<IdentityState>
      this.state = {
        version: 2,
        accounts: parsed.accounts ?? {},
        accountChats: parsed.accountChats ?? {},
        pendingLinks: parsed.pendingLinks ?? {},
      }
    } catch {
      this.state = {
        version: 2,
        accounts: {},
        accountChats: {},
        pendingLinks: {},
      }
      await this.flushState(this.state)
    }

    return this.state
  }

  private async flushState(state: IdentityState): Promise<void> {
    this.state = state
    await mkdir(this.identitiesDir, { recursive: true })
    await writeFile(
      this.indexPath,
      `${JSON.stringify(state, null, 2)}\n`,
    )
  }

  private accountKey(channel: string, senderId: string): string {
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
    return this.sanitizeProfileName(`${baseName}-${suffix}`)
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
