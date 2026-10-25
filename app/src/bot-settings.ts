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

export function createBotSettingsClient(base: string, projectId: string, request: typeof fetch = fetch) {
  async function json(path: string, init?: RequestInit): Promise<unknown> {
    const response = await request(apiUrl(base, `/api/channels${path}`), {
      ...init, headers: { 'Content-Type': 'application/json' },
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
        return { botInstanceId: id, platform: String(entry.platform), conversationId: entry.conversationId,
          name: entry.name as string | undefined, lastSeen: entry.lastSeen }
      })
    },
    async challenge(id: string) {
      return await json(`/${encodeURIComponent(id)}/owner-challenge`, { method: 'POST' }) as { challenge: string; expiresAt: string }
    },
    async candidate(id: string) {
      return await json(`/${encodeURIComponent(id)}/owner-candidate`) as { candidate?: string }
    },
    async confirm(id: string, challenge: string) {
      await json(`/${encodeURIComponent(id)}/owner-confirm`, { method: 'POST', body: JSON.stringify({ challenge }) })
    },
    async revoke(id: string) { await json(`/${encodeURIComponent(id)}/owner`, { method: 'DELETE' }) },
    async remove(id: string, signal?: AbortSignal) {
      const result = await json(`/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      if (!isRecord(result) || result.deleted !== true) throw new Error(t('Main did not confirm bot removal. Refresh before retrying.'))
    },
  }
}

/** Names are untrusted display data and deliberately excluded from the authoring prompt. */
export function serviceGroupAuthoringRequest(group: { botInstanceId: string; platform: string; conversationId: string }): string {
  return t('Prepare an explicit Agent binding for this discovered service group using authoring_change. Ask me which Agent and access scope to use; preserve other bindings. Validate and propose for owner review; do not publish automatically. Target:') + '\n' +
    JSON.stringify({ botInstanceId: group.botInstanceId, platform: group.platform, conversationId: group.conversationId }, null, 2)
}
