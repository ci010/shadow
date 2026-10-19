import { t } from './i18n.ts'
import type { ChannelId, ChannelSetupStatus } from '../../src/channels/setup-contract.ts'
import { isRecord } from './folders-sidebar.ts'
import { apiUrl } from './api-url.ts'

export type ChannelDraft = Record<string, string | boolean>
export interface ChannelField {
  key: string
  label: string
  kind: 'text' | 'password' | 'checkbox' | 'select' | 'list' | 'number'
  required?: boolean
  advanced?: boolean
  default?: string | boolean
  hint?: string
  options?: readonly string[]
}
const accessFields: ChannelField[] = [
  { key: 'allowFrom', get label() { return t('Allowed sender IDs') }, kind: 'list', advanced: true, get hint() { return t('One ID per line. Empty allows all senders permitted by the platform.') } },
  { key: 'adminChats', get label() { return t('Admin group chat IDs') }, kind: 'list', advanced: true, get hint() { return t('One ID per line. Grants admin privileges, not audience trust. Direct messages already have admin privileges.') } },
  { key: 'trustedChats', get label() { return t('Trusted group or channel IDs') }, kind: 'list', advanced: true, get hint() { return t('One exact ID per line, including threads separately. Only list conversations where you trust everyone who can read replies. Uses normal assistant behavior; grants no admin privileges.') } },
]
export const channelDefinitions: Array<{
  id: ChannelId; label: string; description: string; portal: string; instructions: string[]; fields: ChannelField[]
}> = [
  {
    id: 'qq', label: 'QQ', get description() { return t('Connect an official QQ bot to group chats and direct messages.') }, portal: 'https://q.qq.com/',
    get instructions() { return [t('Create a bot on the QQ Open Platform and copy its App ID and App Secret.'), t('Enable the group and direct-message events approved for your bot. For test accounts, use sandbox mode.'), t('Enable QQ\'s receive-all-messages capability to retain group context even without a mention.')] },
    get fields(): ChannelField[] { return [
      { key: 'appId', label: t('App ID'), kind: 'text', required: true },
      { key: 'secret', label: t('App Secret'), kind: 'password', required: true },
      { key: 'triggerMode', label: t('Trigger model on'), kind: 'select', options: ['mention', 'all'], default: 'mention', hint: t('Default: only @mentions trigger a model call in groups. Other messages are saved as context without a model call. All messages triggers on every received group message. Direct messages always trigger.') },
      { key: 'sandbox', label: t('Use sandbox'), kind: 'checkbox', default: false },
      { key: 'markdown', label: t('Send Markdown messages'), kind: 'checkbox', default: true },
      { key: 'token', label: t('Legacy bot token'), kind: 'password', advanced: true, hint: t('Only needed for legacy guild APIs.') },
      { key: 'intents', label: t('Gateway intents'), kind: 'number', advanced: true, hint: t('Optional bitmask. Leave blank to keep the saved value or bot defaults.') },
      ...accessFields,
    ] },
  },
  {
    id: 'feishu', get label() { return t('Feishu') }, get description() { return t('Connect a Feishu app bot using a long-lived connection.') }, portal: 'https://open.feishu.cn/app',
    get instructions() { return [t('Create an app, enable its bot capability and copy the App ID and App Secret.'), t('Subscribe to message events using the long connection mode, grant the required message permissions, and publish the app.')] },
    get fields(): ChannelField[] { return [
      { key: 'appId', label: t('App ID'), kind: 'text', required: true },
      { key: 'appSecret', label: t('App Secret'), kind: 'password', required: true },
      { key: 'encryptKey', label: t('Encryption key'), kind: 'password', advanced: true },
      { key: 'verificationToken', label: t('Verification token'), kind: 'password', advanced: true },
      ...accessFields,
    ] },
  },
  {
    id: 'discord', label: 'Discord', get description() { return t('Connect a bot to your Discord servers and direct messages.') }, portal: 'https://discord.com/developers/applications',
    get instructions() { return [t('Create an application and bot in the Discord Developer Portal, then copy the bot token.'), t('Enable the Message Content intent and invite the bot with permissions to view channels and send messages.'), t('After connecting, open Discord access to assign Agents and permissions. Channels and DMs stay closed until assigned.')] },
    get fields(): ChannelField[] { return [
      { key: 'token', label: t('Bot token'), kind: 'password', required: true },
      { key: 'triggerMode', label: t('Legacy response mode'), kind: 'select', advanced: true, options: ['mention', 'all'], default: 'mention', hint: t('Project Bots use the per-channel trigger in Discord access instead of this legacy default.') },
      { key: 'memberIntent', label: t('Request Guild Members intent'), kind: 'checkbox', default: false, hint: t('Enable Server Members intent in the Discord Developer Portal first. This provides live membership-change events; REST permissions are still checked for every request and delivery.') },
      { key: 'reactionEmoji', label: t('Received-message reaction'), kind: 'text', default: '👀', advanced: true, hint: t('Leave empty to disable the reaction.') },
      ...accessFields.map(field => field.key === 'adminChats'
        ? { ...field, label: t('Legacy admin channel IDs'), hint: t('Retained for compatibility only. Project Discord permissions are configured through Discord access; DMs are not administrators.') }
        : field.key === 'allowFrom' ? { ...field, hint: t('Optional connection-wide sender ceiling. Per-channel users and roles must also permit the sender.') } : field),
    ] },
  },
  {
    id: 'wechat', label: 'WeChat', get description() { return t('WeChat supports personal Bots only. Scan with your own WeChat account, then verify the owner.') }, portal: '',
    get instructions() { return [t('Save and connect, generate the WeChat login QR code, scan and confirm in WeChat, then check login and pair the owner.')] },
    get fields() { return accessFields.filter(field => field.key === 'allowFrom') },
  },
]
const stateLabels: Record<ChannelSetupStatus['state'], string> = {
  get disabled() { return t('Disconnected') }, get unconfigured() { return t('Not configured') }, get connecting() { return t('Connecting') },
  get connected() { return t('Connected') }, get disconnected() { return t('Disconnected') }, get error() { return t('Needs attention') },
  get running() { return t('Running · connection unverified') }, get 'restart-required'() { return t('Restart required') },
}
export function channelStateLabel(channel: Pick<ChannelSetupStatus, 'state' | 'configured'>): string {
  return !channel.configured && channel.state === 'disabled' ? t('Not configured') : stateLabels[channel.state]
}
export function channelDraft(channel: ChannelSetupStatus): ChannelDraft {
  return Object.fromEntries(channelDefinitions.find(item => item.id === channel.id)!.fields.map(field => {
    const value = channel.config[field.key]
    return [field.key, field.kind === 'password' ? '' : field.kind === 'list' ? Array.isArray(value) ? value.join('\n') : ''
      : field.kind === 'checkbox' ? typeof value === 'boolean' ? value : field.default ?? false
      : typeof value === 'string' || typeof value === 'number' ? String(value) : field.default ?? '']
  }))
}
export function channelPatch(channel: ChannelSetupStatus, draft: ChannelDraft, enabled: boolean): Record<string, unknown> {
  const patch: Record<string, unknown> = { enabled }
  for (const field of channelDefinitions.find(item => item.id === channel.id)!.fields) {
    const value = draft[field.key]
    if (field.kind === 'checkbox') { patch[field.key] = value === true; continue }
    const text = typeof value === 'string' ? value : ''
    if (field.required && enabled && !text.trim() && !(field.kind === 'password' && channel.secrets[field.key])) {
      throw new Error(t('{label} is required to connect {label2}.', { label: field.label, label2: channel.label }))
    }
    if (field.kind === 'password') {
      if (text.trim()) patch[field.key] = text.trim()
    } else if (field.kind === 'number') {
      if (text.trim()) {
        const number = Number(text)
        if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) throw new Error(t('{label} must be a non-negative 32-bit integer.', { label: field.label }))
        patch[field.key] = number
      }
    } else if (field.kind === 'list') {
      patch[field.key] = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
    } else if (field.kind === 'select') {
      if (!field.options?.includes(text)) throw new Error(t('Choose a valid value for {label}.', { label: field.label }))
      patch[field.key] = text
    } else patch[field.key] = text.trim()
  }
  return patch
}

export function parseChannelStatus(value: unknown): ChannelSetupStatus {
  const invalid = () => new Error(t('Main returned an invalid channel status. Refresh the list or restart Main.'))
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.label !== 'string'
    || typeof value.enabled !== 'boolean' || typeof value.configured !== 'boolean'
    || typeof value.state !== 'string' || !Object.hasOwn(stateLabels, value.state)
    || (value.message !== undefined && typeof value.message !== 'string')
    || !isRecord(value.config) || !isRecord(value.secrets)) throw invalid()
  const definition = channelDefinitions.find(item => item.id === value.id)
  if (!definition) throw invalid()
  const config: ChannelSetupStatus['config'] = {}
  const secrets: Record<string, boolean> = {}
  for (const [key, entry] of Object.entries(value.config)) {
    if (key === 'enabled' && typeof entry === 'boolean') continue
    const field = definition.fields.find(item => item.key === key)
    if (!field || field.kind === 'password') throw invalid()
    if (field.kind === 'checkbox' ? typeof entry !== 'boolean'
      : field.kind === 'number' ? typeof entry !== 'number' || !Number.isSafeInteger(entry)
      : field.kind === 'list' ? !Array.isArray(entry) || !entry.every(item => typeof item === 'string')
      : typeof entry !== 'string' || (field.kind === 'select' && !field.options?.includes(entry))) throw invalid()
    config[key] = entry as string | boolean | number | string[]
  }
  for (const [key, present] of Object.entries(value.secrets)) {
    if (!definition.fields.some(field => field.key === key && field.kind === 'password') || typeof present !== 'boolean') throw invalid()
    secrets[key] = present
  }
  return { id: definition.id, label: value.label, enabled: value.enabled, configured: value.configured,
    state: value.state as ChannelSetupStatus['state'], config, secrets,
    ...(typeof value.message === 'string' ? { message: value.message } : {}) }
}
export function parseChannelList(value: unknown): ChannelSetupStatus[] {
  if (!isRecord(value) || !Array.isArray(value.channels)) throw new Error(t('Main returned an invalid channel list. Refresh to retry.'))
  const channels = value.channels.map(parseChannelStatus)
  if (channels.length !== channelDefinitions.length || new Set(channels.map(item => item.id)).size !== channels.length) {
    throw new Error(t('Main returned an incomplete channel list. Refresh or restart Main.'))
  }
  return channelDefinitions.map(definition => channels.find(item => item.id === definition.id)!)
}

export function createChannelSettingsClient(apiBase: string, request: typeof fetch = fetch) {
  async function json(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await request(apiUrl(apiBase, path).toString(), { ...init, headers: { 'Content-Type': 'application/json' },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error(init.method === 'PATCH' ? t('Could not confirm the channel update. Refresh its status before retrying.') : t('Could not reach channel settings. Check Main and retry.'))
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? t('Channel settings require a Main administrator.')
      : response.status === 400 ? t('Check the channel credentials and settings, then retry.')
      : response.status === 409 ? t('The channel is busy changing connection. Refresh its status before retrying.')
      : t('Channel settings are unavailable. Check Main and retry.'))
    try { return await response.json() }
    catch { throw new Error(t('Main returned an unreadable channel response. Refresh its status before retrying.')) }
  }
  return {
    async list(signal?: AbortSignal) { return parseChannelList(await json('/api/channels', { signal })) },
    async save(id: ChannelId, config: Record<string, unknown>, signal?: AbortSignal) {
      const response = await json(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ config }), signal })
      if (!isRecord(response)) throw new Error(t('Main returned an invalid channel update. Refresh to retry.'))
      const channel = parseChannelStatus(response.channel)
      if (channel.id !== id) throw new Error(t('Main returned another channel. Refresh before retrying.'))
      return channel
    },
  }
}
