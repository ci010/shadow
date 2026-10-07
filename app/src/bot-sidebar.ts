import { t } from './i18n.ts'
import type { SidebarSession } from './folders-sidebar.ts'
import type { ChannelSetupStatus, ChannelState } from '../../src/channels/setup-contract.ts'
import { channelStateLabel } from './channel-settings.ts'

export interface SidebarBot {
  id: string
  projectId: string
  platform: string
  displayName: string
  connection?: Pick<ChannelSetupStatus, 'state' | 'configured'>
}

export interface BotConversationGroup {
  id: string
  label: string
  platform: string
  sessions: SidebarSession[]
  connection: ReturnType<typeof botConnectionIndicator>
}

const platformNames: Record<string, string> = { qq: 'QQ', discord: 'Discord', get feishu() { return t('Feishu') } }
export function botPlatformLabel(platform: string) { return platformNames[platform] ?? platform }
const connectionIcons: Record<ChannelState, string> = {
  connected: 'i-lucide-circle-check', connecting: 'i-lucide-loader-circle',
  disconnected: 'i-lucide-circle-minus', disabled: 'i-lucide-circle-minus',
  unconfigured: 'i-lucide-circle-dashed', error: 'i-lucide-circle-alert',
  running: 'i-lucide-circle-help', 'restart-required': 'i-lucide-refresh-cw',
}

export function botConnectionIndicator(connection?: SidebarBot['connection']) {
  return {
    state: connection?.state ?? 'unknown',
    label: connection ? channelStateLabel(connection) : t('Connection status unavailable'),
    icon: connection ? connectionIcons[connection.state] : 'i-lucide-circle-help',
  }
}

/** Folder and automation ownership is resolved before splitting the remaining Chats. */
export function groupBotConversations(sessions: SidebarSession[], projectId: string | undefined, bots: SidebarBot[] = []) {
  const chats: SidebarSession[] = []
  const groups = new Map<string, BotConversationGroup>()
  for (const session of sessions) {
    const address = session.channelAddress
    if (projectId && (session.projectId && session.projectId !== projectId || address && address.projectId !== projectId)) continue
    if (!projectId || !address) { chats.push(session); continue }
    let group = groups.get(address.botInstanceId)
    if (!group) {
      const bot = bots.find(bot => bot.projectId === projectId && bot.id === address.botInstanceId && bot.platform === address.platform)
      group = {
        id: address.botInstanceId, platform: address.platform,
        label: bot?.displayName || `${botPlatformLabel(address.platform)} · ${address.botInstanceId}`,
        connection: botConnectionIndicator(bot?.connection),
        sessions: [],
      }
      groups.set(group.id, group)
    }
    group.sessions.push(session)
  }
  return { chats, bots: [...groups.values()] }
}

export function botSidebarStorageKey(apiBase: string, projectId: string): string {
  return `shadow:bot-sidebar:${JSON.stringify([apiBase, projectId])}`
}

export function restoreCollapsedBots(storage: Pick<Storage, 'getItem'>, apiBase: string, projectId: string): Set<string> {
  const raw = storage.getItem(botSidebarStorageKey(apiBase, projectId))
  if (raw === null) return new Set()
  const value: unknown = JSON.parse(raw)
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id)) throw new TypeError(t('Invalid bot sidebar preferences'))
  return new Set(value)
}

export function saveCollapsedBots(storage: Pick<Storage, 'setItem'>, apiBase: string, projectId: string, collapsed: ReadonlySet<string>): void {
  storage.setItem(botSidebarStorageKey(apiBase, projectId), JSON.stringify([...collapsed]))
}
