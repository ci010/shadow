import type { SidebarSession } from './folders-sidebar.ts'

const PREFIX = 'discord-channel:'
export interface DiscordChannelKey { projectId: string; botInstanceId: string; guildId: string; channelId: string }
export function discordChannelId(key: DiscordChannelKey): string {
  return PREFIX + JSON.stringify([key.projectId, key.botInstanceId, key.guildId, key.channelId])
}
export function discordChannelKey(id: string): DiscordChannelKey | undefined {
  if (!id.startsWith(PREFIX)) return
  try {
    const parts: unknown = JSON.parse(id.slice(PREFIX.length))
    if (!Array.isArray(parts) || parts.length !== 4 || parts.some(p => typeof p !== 'string' || !p)) return
    const [projectId, botInstanceId, guildId, channelId] = parts as string[]
    return { projectId, botInstanceId, guildId, channelId }
  } catch { return }
}
export function isDisplayOnlyConversation(id: string): boolean {
  return id.startsWith('observed-group:') || id.startsWith(PREFIX)
}
export function discordThread(type: number): boolean { return type === 10 || type === 11 || type === 12 }
/** No ancestry inference from names, categories, session lineage or ID prefixes. */
export function discordParentKey(session: SidebarSession): DiscordChannelKey | undefined {
  const address = session.channelAddress, channel = session.discordChannel
  if (!address || address.platform !== 'discord' || !channel || channel.id !== address.conversationId || !channel.guildId
    || session.projectId && session.projectId !== address.projectId) return
  const channelId = discordThread(channel.type) ? channel.parentId : channel.id
  if (!channelId) return
  return { projectId: address.projectId, botInstanceId: address.botInstanceId, guildId: channel.guildId, channelId }
}
export function discordChannelHistories(sessions: readonly SidebarSession[], key: DiscordChannelKey): SidebarSession[] {
  const id = discordChannelId(key)
  return sessions.filter(session => {
    const parent = discordParentKey(session)
    return parent && discordChannelId(parent) === id
  })
}
export function projectDiscordChannels(sessions: SidebarSession[]): SidebarSession[] {
  const result: SidebarSession[] = [], parents = new Map<string, SidebarSession>()
  for (const session of sessions) {
    const key = discordParentKey(session)
    if (!key) { result.push(session); continue }
    const id = discordChannelId(key)
    let parent = parents.get(id)
    const channel = session.discordChannel!
    const name = discordThread(channel.type) ? channel.parentName : channel.name
    if (!parent) {
      parent = { sessionId: id, projectId: key.projectId, channelAddress: { ...session.channelAddress!, conversationId: key.channelId },
        label: name?.trim() || key.channelId, isDirectChat: false, isCurrent: false, parentSessionId: null, depth: 0,
        discordHistoryIds: [], lastActivityAt: session.lastActivityAt }
      parents.set(id, parent); result.push(parent)
    }
    parent.discordHistoryIds!.push(session.sessionId)
    if (name?.trim()) parent.label = name.trim()
    if ((session.lastActivityAt ?? '') > (parent.lastActivityAt ?? '')) parent.lastActivityAt = session.lastActivityAt
  }
  return result.map(row => {
    if (!row.discordHistoryIds || row.discordHistoryIds.length !== 1) return row
    const original = sessions.find(session => session.sessionId === row.discordHistoryIds![0])!
    const type = original.discordChannel!.type
    return !discordThread(type) && type !== 15 && type !== 16 ? original : row
  })
}

export interface DiscordPost {
  conversationId: string
  title: string
  lastActivityAt?: string
  histories: SidebarSession[]
}
/** Caller supplies the exact scoped parent histories; never merge history identities. */
export function discordChannelPosts(sessions: readonly SidebarSession[], key: DiscordChannelKey): DiscordPost[] {
  const posts = new Map<string, DiscordPost>()
  for (const history of discordChannelHistories(sessions, key)) {
    const id = history.channelAddress!.conversationId
    let post = posts.get(id)
    if (!post) {
      post = { conversationId: id, title: history.discordChannel?.name?.trim() || history.title?.trim() || history.label, histories: [], lastActivityAt: history.lastActivityAt }
      posts.set(id, post)
    }
    if (history.discordChannel?.name?.trim()) post.title = history.discordChannel.name.trim()
    post.histories.push(history)
    if ((history.lastActivityAt ?? '') > (post.lastActivityAt ?? '')) post.lastActivityAt = history.lastActivityAt
  }
  return [...posts.values()].sort((a, b) => (b.lastActivityAt ?? '').localeCompare(a.lastActivityAt ?? '') || a.conversationId.localeCompare(b.conversationId))
}
