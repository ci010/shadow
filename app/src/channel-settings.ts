import type { ChannelId, ChannelSetupStatus } from '../../src/channels/setup-contract.ts'
import { isRecord } from './projects-sidebar.ts'

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
  { key: 'allowFrom', label: 'Allowed sender IDs', kind: 'list', advanced: true, hint: 'One ID per line. Empty allows all senders permitted by the platform.' },
  { key: 'adminChats', label: 'Admin group chat IDs', kind: 'list', advanced: true, hint: 'One ID per line. Only add trusted groups; direct messages already have admin privileges.' },
]
export const channelDefinitions: Array<{
  id: ChannelId; label: string; description: string; portal: string; instructions: string[]; fields: ChannelField[]
}> = [
  {
    id: 'qq', label: 'QQ', description: 'Connect an official QQ bot to group chats and direct messages.', portal: 'https://q.qq.com/',
    instructions: ['Create a bot on the QQ Open Platform and copy its App ID and App Secret.', 'Enable the group and direct-message events approved for your bot. For test accounts, use sandbox mode.'],
    fields: [
      { key: 'appId', label: 'App ID', kind: 'text', required: true },
      { key: 'secret', label: 'App Secret', kind: 'password', required: true },
      { key: 'sandbox', label: 'Use sandbox', kind: 'checkbox', default: false },
      { key: 'markdown', label: 'Send Markdown messages', kind: 'checkbox', default: true },
      { key: 'token', label: 'Legacy bot token', kind: 'password', advanced: true, hint: 'Only needed for legacy guild APIs.' },
      { key: 'intents', label: 'Gateway intents', kind: 'number', advanced: true, hint: 'Optional bitmask. Leave blank to keep the saved value or bot defaults.' },
      ...accessFields,
    ],
  },
  {
    id: 'feishu', label: 'Feishu', description: 'Connect a Feishu app bot using a long-lived connection.', portal: 'https://open.feishu.cn/app',
    instructions: ['Create an app, enable its bot capability and copy the App ID and App Secret.', 'Subscribe to message events using the long connection mode, grant the required message permissions, and publish the app.'],
    fields: [
      { key: 'appId', label: 'App ID', kind: 'text', required: true },
      { key: 'appSecret', label: 'App Secret', kind: 'password', required: true },
      { key: 'encryptKey', label: 'Encryption key', kind: 'password', advanced: true },
      { key: 'verificationToken', label: 'Verification token', kind: 'password', advanced: true },
      ...accessFields,
    ],
  },
  {
    id: 'discord', label: 'Discord', description: 'Connect a bot to your Discord servers and direct messages.', portal: 'https://discord.com/developers/applications',
    instructions: ['Create an application and bot in the Discord Developer Portal, then copy the bot token.', 'Enable the Message Content intent and invite the bot with permissions to view channels and send messages.'],
    fields: [
      { key: 'token', label: 'Bot token', kind: 'password', required: true },
      { key: 'triggerMode', label: 'Respond to', kind: 'select', options: ['mention', 'all'], default: 'mention', hint: 'Mention mode responds to mentions, direct messages and replies to the bot.' },
      { key: 'reactionEmoji', label: 'Received-message reaction', kind: 'text', default: '👀', advanced: true, hint: 'Leave empty to disable the reaction.' },
      ...accessFields,
    ],
  },
]
const stateLabels: Record<ChannelSetupStatus['state'], string> = {
  disabled: 'Disconnected', unconfigured: 'Not configured', connecting: 'Connecting',
  connected: 'Connected', disconnected: 'Disconnected', error: 'Needs attention',
  running: 'Running · connection unverified', 'restart-required': 'Restart required',
}
export function channelStateLabel(channel: ChannelSetupStatus): string {
  return !channel.configured && channel.state === 'disabled' ? 'Not configured' : stateLabels[channel.state]
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
      throw new Error(`${field.label} is required to connect ${channel.label}.`)
    }
    if (field.kind === 'password') {
      if (text.trim()) patch[field.key] = text.trim()
    } else if (field.kind === 'number') {
      if (text.trim()) {
        const number = Number(text)
        if (!Number.isSafeInteger(number) || number < 0 || number > 0xffffffff) throw new Error(`${field.label} must be a non-negative 32-bit integer.`)
        patch[field.key] = number
      }
    } else if (field.kind === 'list') {
      patch[field.key] = [...new Set(text.split(/\r?\n/).map(line => line.trim()).filter(Boolean))]
    } else if (field.kind === 'select') {
      if (!field.options?.includes(text)) throw new Error(`Choose a valid value for ${field.label}.`)
      patch[field.key] = text
    } else patch[field.key] = text.trim()
  }
  return patch
}

export function parseChannelStatus(value: unknown): ChannelSetupStatus {
  const invalid = () => new Error('Main returned an invalid channel status. Refresh the list or restart Main.')
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
  if (!isRecord(value) || !Array.isArray(value.channels)) throw new Error('Main returned an invalid channel list. Refresh to retry.')
  const channels = value.channels.map(parseChannelStatus)
  if (channels.length !== channelDefinitions.length || new Set(channels.map(item => item.id)).size !== channels.length) {
    throw new Error('Main returned an incomplete channel list. Refresh or restart Main.')
  }
  return channelDefinitions.map(definition => channels.find(item => item.id === definition.id)!)
}

export function createChannelSettingsClient(apiBase: string, request: typeof fetch = fetch) {
  async function json(path: string, init: RequestInit): Promise<unknown> {
    let response: Response
    try {
      response = await request(`${apiBase}${path}`, { ...init, headers: { 'Content-Type': 'application/json' },
        signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000) })
    } catch (error) {
      if (init.signal?.aborted) throw error
      throw new Error(init.method === 'PATCH' ? 'Could not confirm the channel update. Refresh its status before retrying.' : 'Could not reach channel settings. Check Main and retry.')
    }
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403
      ? 'Channel settings require a Main administrator.'
      : response.status === 400 ? 'Check the channel credentials and settings, then retry.'
      : response.status === 409 ? 'The channel is busy changing connection. Refresh its status before retrying.'
      : 'Channel settings are unavailable. Check Main and retry.')
    try { return await response.json() }
    catch { throw new Error('Main returned an unreadable channel response. Refresh its status before retrying.') }
  }
  return {
    async list(signal?: AbortSignal) { return parseChannelList(await json('/api/channels', { signal })) },
    async save(id: ChannelId, config: Record<string, unknown>, signal?: AbortSignal) {
      const response = await json(`/api/channels/${id}`, { method: 'PATCH', body: JSON.stringify({ config }), signal })
      if (!isRecord(response)) throw new Error('Main returned an invalid channel update. Refresh to retry.')
      const channel = parseChannelStatus(response.channel)
      if (channel.id !== id) throw new Error('Main returned another channel. Refresh before retrying.')
      return channel
    },
  }
}
