import qrcode from 'qrcode-generator'
import { t } from './i18n.ts'
import type { BotInstanceStatus, ChannelId, ChannelSetupStatus } from '../../src/channels/setup-contract.ts'
import { channelDefinitions, channelDraft, channelPatch, parseChannelStatus, type ChannelDraft } from './channel-settings.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export type { BotInstanceStatus }

/** iLink returns QR content, not necessarily an image URL. Encode locally. */
export function wechatLoginQr(value: unknown): string {
  if (!isRecord(value) || typeof value.qrcodeUrl !== 'string' || !value.qrcodeUrl.trim() || value.qrcodeUrl.length > 4096) {
    throw new Error('Invalid WeChat QR content')
  }
  const qr = qrcode(0, 'M')
  qr.addData(value.qrcodeUrl)
  qr.make()
  return qr.createDataURL(5, 20)
}

export function botChannel(bot: BotInstanceStatus): ChannelSetupStatus {
  return { ...bot, id: bot.platform, label: bot.displayName }
}

export function botDraft(bot: BotInstanceStatus): ChannelDraft {
  return { ...channelDraft(botChannel(bot)), displayName: bot.displayName }
}

/** The connection card edits only required platform credentials, never access or BOT files. */
export function botConnectionFields(platform: ChannelId) {
  return channelDefinitions.find(item => item.id === platform)!.fields.filter(field => field.required)
}

export function botConnectionDraft(platform: ChannelId): ChannelDraft {
  // Even non-secret App IDs are entered privately; saved values need not be echoed.
  return Object.fromEntries(botConnectionFields(platform).map(field => [field.key, '']))
}

export function botConnectionPatch(bot: BotInstanceStatus, draft: ChannelDraft, enabled: boolean) {
  const config: Record<string, unknown> = { enabled }
  for (const field of botConnectionFields(bot.platform)) {
    const entry = draft[field.key]
    const value = typeof entry === 'string' ? entry.trim() : ''
    const stored = bot.config[field.key]
    const saved = field.kind === 'password' ? bot.secrets[field.key] === true
      : typeof stored === 'string' && !!stored.trim()
    if (enabled && !value && !saved) throw new Error(t('{label} is required to connect {label2}.', { label: field.label, label2: bot.displayName }))
    if (value) config[field.key] = value
  }
  return { config }
}

export function botPatch(bot: BotInstanceStatus, draft: ChannelDraft, enabled: boolean) {
  const displayName = typeof draft.displayName === 'string' ? draft.displayName.trim() : ''
  if (!displayName) throw new Error(t('Enter a bot name.'))
  return { displayName, config: channelPatch(botChannel(bot), draft, enabled) }
}

/** Resume from server facts, never browser-only completion flags or credential values. */
export function qqSetupProgress(bot: BotInstanceStatus) {
  const credentialsSaved = typeof bot.config.appId === 'string' && !!bot.config.appId.trim() && bot.secrets.secret === true
  const connected = bot.state === 'connected'
  return { credentialsSaved, connected,
    step: !credentialsSaved ? 'credentials' : !connected ? 'connection' : 'access',
    ownerReady: bot.purpose === 'personal' && connected && bot.ownerVerified === true }
}

export function parseBotStatus(value: unknown, projectId: string): BotInstanceStatus {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || value.projectId !== projectId || typeof value.platform !== 'string'
    || !channelDefinitions.some(item => item.id === value.platform)
    || typeof value.displayName !== 'string' || !value.displayName.trim()) {
    throw new Error(t('Main returned invalid bot ownership or status. Refresh before retrying.'))
  }
  const status = parseChannelStatus({ ...value, id: value.platform })
  return { ...status, purpose: value.purpose === 'personal' || value.purpose === 'service' ? value.purpose : 'legacy', ownerVerified: value.ownerVerified === true, id: value.id, projectId, platform: status.id, displayName: value.displayName }
}

export function parseBotList(value: unknown, projectId: string): BotInstanceStatus[] {
  if (!isRecord(value) || !Array.isArray(value.channels)) throw new Error(t('Main returned an invalid bot list. Refresh to retry.'))
  const bots = value.channels.map(item => parseBotStatus(item, projectId))
  if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw new Error(t('Main returned duplicate bot IDs. Refresh to retry.'))
  return bots
}

/** Sidebar facts do not depend on the editable configuration schema/version. */
export function parseBotCatalog(value: unknown, projectId: string): import('./bot-sidebar.ts').SidebarBot[] {
  if (!isRecord(value) || !Array.isArray(value.channels)) throw new Error(t('Main returned an invalid bot list. Refresh to retry.'))
  const bots = value.channels.map(value => {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id || value.projectId !== projectId
      || !channelDefinitions.some(item => item.id === value.platform)
      || typeof value.displayName !== 'string' || !value.displayName.trim()) {
      throw new Error(t('Main returned invalid bot ownership or status. Refresh before retrying.'))
    }
    // Unknown/malformed status must not turn into a connected indicator. Names
    // remain useful even if this server's settings contract is newer than ours.
    const states = ['disabled', 'unconfigured', 'connecting', 'connected', 'disconnected', 'error', 'running', 'restart-required']
    const connection = typeof value.configured === 'boolean' && states.includes(value.state as string)
      ? { configured: value.configured, state: value.state as BotInstanceStatus['state'] } : undefined
    return { id: value.id, projectId, platform: value.platform as BotInstanceStatus['platform'], displayName: value.displayName,
      ...(connection ? { connection } : {}) }
  })
  if (new Set(bots.map(bot => bot.id)).size !== bots.length) throw new Error(t('Main returned duplicate bot IDs. Refresh to retry.'))
  return bots
}

export function createBotSettingsClient(base: string, projectId: string, request: typeof fetch = fetch) {
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(apiUrl(base, `/api/channels${path}`), {
      ...init, redirect: 'error', headers: { 'Content-Type': 'application/json' },
      signal: init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
    })
    if (!response.ok) {
      throw new Error(response.status === 409 ? t('This bot is already connected elsewhere or is changing connection. Refresh its status before retrying.')
        : response.status === 400 ? t('Check the bot name, credentials and settings, then retry.')
        : response.status === 401 || response.status === 403 ? t('Bot settings require a Main administrator.')
        : t('Could not confirm the bot update or status. Check Main and refresh before retrying.'))
    }
    return response.json()
  }
  function parseUpdate(value: unknown, id?: string) {
    if (!isRecord(value)) throw new Error(t('Main returned an invalid bot update. Refresh to retry.'))
    const bot = parseBotStatus(value.channel, projectId)
    if (id && bot.id !== id) throw new Error(t('Main returned another bot. Refresh before retrying.'))
    return bot
  }
  return {
    async list(signal?: AbortSignal) { return parseBotList(await json('', { signal }), projectId) },
    async catalog(signal?: AbortSignal) { return parseBotCatalog(await json('', { signal }), projectId) },
    async create(platform: ChannelId, displayName: string, signal: AbortSignal | undefined, purpose: 'personal' | 'service') {
      if (purpose !== 'personal' && purpose !== 'service') throw new Error('Select a Bot role.')
      if (platform === 'wechat' && purpose !== 'personal') throw new Error(t('WeChat supports personal Bots only.'))
      if (!displayName.trim()) throw new Error(t('Enter a bot name.'))
      return parseUpdate(await json('', { method: 'POST', body: JSON.stringify({ purpose, platform, displayName: displayName.trim(), config: { enabled: false } }), signal }))
    },
    async save(id: string, patch: { purpose?: 'personal' | 'service'; displayName?: string; config?: Record<string, unknown> }, signal?: AbortSignal) {
      return parseUpdate(await json(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch), signal }), id)
    },
    async wechat(id: string, operation: 'login' | 'wait', signal?: AbortSignal) {
      const value = await json(`/${encodeURIComponent(id)}/wechat/${operation}`, { method: 'POST', signal })
      if (!isRecord(value)) throw new Error('Invalid WeChat login response')
      return value
    },
    async pendingGroups(id: string, signal?: AbortSignal) {
      const result = await json(`/${encodeURIComponent(id)}/pending-groups`, { method: 'GET', signal })
      if (!isRecord(result) || !Array.isArray(result.groups)) throw new Error('Invalid discovery response')
      return result.groups.map((entry: unknown) => {
        if (!isRecord(entry) || entry.botInstanceId !== id || !['qq', 'feishu'].includes(String(entry.platform)) ||
          typeof entry.conversationId !== 'string' || typeof entry.lastSeen !== 'number' ||
          (entry.name !== undefined && typeof entry.name !== 'string')) throw new Error('Invalid discovery entry')
        const messages = entry.messages ?? []
        if (!Array.isArray(messages) || messages.length > 20 || messages.some(message => !isRecord(message) ||
          typeof message.id !== 'string' || typeof message.sender !== 'string' || typeof message.text !== 'string' ||
          message.text.length > 2000 || typeof message.receivedAt !== 'number')) throw new Error('Invalid discovery messages')
        return { botInstanceId: id, platform: String(entry.platform), conversationId: entry.conversationId,
          name: entry.name as string | undefined, lastSeen: entry.lastSeen,
          messages: messages as Array<{ id: string; sender: string; text: string; receivedAt: number }> }
      })
    },
    async challenge(id: string, signal?: AbortSignal) {
      const value = await json(`/${encodeURIComponent(id)}/owner-challenge`, { method: 'POST', signal })
      if (!isRecord(value) || typeof value.challenge !== 'string' || !value.challenge || typeof value.expiresAt !== 'string') throw new Error('Invalid owner challenge')
      return { challenge: value.challenge, expiresAt: value.expiresAt }
    },
    async candidate(id: string, signal?: AbortSignal) {
      const value = await json(`/${encodeURIComponent(id)}/owner-candidate`, { signal })
      if (!isRecord(value) || (value.candidate !== undefined && typeof value.candidate !== 'string')) throw new Error('Invalid owner candidate')
      return { candidate: value.candidate as string | undefined }
    },
    async confirm(id: string, challenge: string, signal?: AbortSignal) {
      await json(`/${encodeURIComponent(id)}/owner-confirm`, { method: 'POST', body: JSON.stringify({ challenge }), signal })
    },
    async revoke(id: string, signal?: AbortSignal) { await json(`/${encodeURIComponent(id)}/owner`, { method: 'DELETE', signal }) },
    async remove(id: string, signal?: AbortSignal) {
      const result = await json(`/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      if (!isRecord(result) || result.deleted !== true) throw new Error(t('Main did not confirm bot removal. Refresh before retrying.'))
    },
  }
}
