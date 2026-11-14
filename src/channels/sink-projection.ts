import { createHash } from 'node:crypto'
import { parseChannelSource, type ChannelSource } from './passive-contract.ts'
import type { ChannelSinkReceiver, ConnectionSinkProjection, ChannelSinkAddress } from './sink-contract.ts'

export interface SinkObservation { connection: string; platform: string; conversation: string; parent?: string }
export interface SinkHistory { sessionId: string; projectId?: string; channelSource?: unknown }
const safeName = (value: string) => value.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[url-omitted]').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 100)
export function sinkReceiverId(address: ChannelSinkAddress): string {
  return createHash('sha256').update(JSON.stringify([address.projectId, address.botInstanceId, address.platform, address.conversationId])).digest('hex')
}

/** Pure projection of actual receipt/discovery facts. No connectors, BOT modules,
 * storage writes, Session creation, guessed platform ancestry or binding fallback.
 * Child receipts retain their own histories; graph receivers aggregate the parent.
 */
export function connectionSinkProjection(options: {
  projectId: string; connectionId: string; platform: ChannelSinkAddress['platform']
  histories: readonly SinkHistory[]; observations: readonly SinkObservation[]
  bots?: ConnectionSinkProjection['bots']
}): ConnectionSinkProjection {
  const { projectId, connectionId, platform } = options
  const base = `v:connections/${encodeURIComponent(connectionId)}`
  const result: ConnectionSinkProjection = { kind: 'connection-sink', id: `connection-sink:${encodeURIComponent(projectId)}:${encodeURIComponent(connectionId)}`,
    projectId, connectionId, connectionPath: `${base}/overview.json`, sinkPath: `${base}/sink.json`,
    sink: { kind: 'common-receipt', reacts: false, navigation: { kind: 'connection-content', projectId, connectionId } },
    receivers: [], bots: options.bots ?? [], guidePath: 'v:bots/authoring' }
  const facts = new Map<string, { address: ChannelSinkAddress; children: boolean; source?: ChannelSource; inboxSessionId?: string }>()
  const fact = (conversationId: string) => {
    let value = facts.get(conversationId)
    if (!value) { value = { address: { projectId, botInstanceId: connectionId, platform, conversationId }, children: false }; facts.set(conversationId, value) }
    return value
  }
  for (const history of options.histories) {
    if (history.projectId !== projectId || history.channelSource === undefined) continue
    let source: ChannelSource | undefined
    try { source = parseChannelSource(history.channelSource, history.sessionId, projectId) } catch { continue }
    if (!source || source.botInstanceId !== connectionId || source.platform !== platform || source.kind === 'direct') continue
    const value = fact(source.parentId ?? source.conversationId)
    if (source.parentId) { value.children = true; value.source ??= source }
    else { value.source = source; value.inboxSessionId = history.sessionId }
  }
  for (const row of options.observations) {
    if (row.connection !== connectionId || row.platform !== platform || !row.conversation || row.conversation.length > 512 || /[\x00-\x1f\x7f]/.test(row.conversation)) continue
    if (row.parent && (row.parent.length > 512 || /[\x00-\x1f\x7f]/.test(row.parent))) continue
    // The stream alone has no conversation kind. An unparented numeric Discord
    // address may be a DM; never invent a group/channel receiver from that ID.
    // Top-level creates already have verified durable ChannelSource metadata;
    // discovery-only public threads carry their transport-verified parent.
    if (!row.parent) continue
    const value = fact(row.parent)
    value.children = true
  }
  for (const value of facts.values()) {
    const { address, source, inboxSessionId, children } = value
    const id = sinkReceiverId(address)
    let navigation: ChannelSinkReceiver['navigation']
    if (platform === 'discord' && children) {
      navigation = { kind: 'channel-content', address: { ...address, platform: 'discord' }, channelType: null,
        guildId: source?.guildId ?? null, view: inboxSessionId ? 'messages-and-threads' : 'threads' }
    } else if (inboxSessionId) navigation = { kind: 'conversation', address, inboxSessionId }
    else if (platform === 'discord') navigation = { kind: 'channel-content', address: { ...address, platform: 'discord' },
      channelType: null, guildId: source?.guildId ?? null, view: 'messages-and-threads' }
    else continue // Never invent an empty parent chat for a discovery-only source.
    result.receivers.push({ id, address, path: `${base}/receivers/${encodeURIComponent(id)}.json`, navigation,
      ...(source?.conversationId === address.conversationId && source.name ? { name: safeName(source.name) } : {}) })
  }
  result.receivers.sort((a, b) => a.id.localeCompare(b.id))
  return result
}
