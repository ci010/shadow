import { t } from './i18n.ts'
import type { BotInstanceStatus, ChannelId, ChannelSetupStatus } from '../../src/channels/setup-contract.ts'
import { channelDefinitions, channelDraft, channelPatch, parseChannelStatus, type ChannelDraft } from './channel-settings.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export type { BotInstanceStatus }

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

export function parseBotStatus(value: unknown, projectId: string): BotInstanceStatus {
  if (!isRecord(value) || typeof value.id !== 'string' || !value.id
    || value.projectId !== projectId || typeof value.platform !== 'string'
    || !channelDefinitions.some(item => item.id === value.platform)
    || typeof value.displayName !== 'string' || !value.displayName.trim()) {
    throw new Error(t('Main returned invalid bot ownership or status. Refresh before retrying.'))
  }
  const status = parseChannelStatus({ ...value, id: value.platform })
  return { ...status, id: value.id, projectId, platform: status.id, displayName: value.displayName }
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
    async create(platform: ChannelId, displayName: string, signal?: AbortSignal) {
      if (!displayName.trim()) throw new Error(t('Enter a bot name.'))
      return parseUpdate(await json('', { method: 'POST', body: JSON.stringify({ platform, displayName: displayName.trim(), config: { enabled: false } }), signal }))
    },
    async save(id: string, patch: { displayName?: string; config?: Record<string, unknown> }, signal?: AbortSignal) {
      return parseUpdate(await json(`/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch), signal }), id)
    },
    async remove(id: string, signal?: AbortSignal) {
      const result = await json(`/${encodeURIComponent(id)}`, { method: 'DELETE', signal })
      if (!isRecord(result) || result.deleted !== true) throw new Error(t('Main did not confirm bot removal. Refresh before retrying.'))
    },
  }
}
