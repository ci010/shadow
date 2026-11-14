import { createHash } from 'node:crypto'
import type { BotInstanceStore } from '../channels/bot-store.ts'
import type { ChannelManager } from '../channels/manager.ts'
import { publishedBotAgentName, type DirectoryBots } from './runtime.ts'
import { bindingSubscribed } from './sdk.ts'
import { channelSessionId } from '../bus/events.ts'
import type { InputListener } from '../input/router.ts'
import type { ConnectionSinkProjection } from '../channels/sink-contract.ts'
import { connectionSinkProjection } from '../channels/sink-projection.ts'

/** Inspection-only DTO: never a Workflow definition, routing authority or run receipt. */
export interface BotWorkflowProjection {
  sinks: ConnectionSinkProjection[]
  connections: Array<{ id: string; displayName: string; platform: string; purpose: string; enabled: boolean; health: string }>
  deployments: Array<{ id: string; state: 'valid' | 'quarantined' | 'unavailable'; mode?: 'service' | 'personal'; agent?: string; revision?: string }>
  bindings: Array<{ id: string; deploymentId: string; connectionId: string; platform: string; topic?: string; enabled: boolean; subscribed: boolean; listener: boolean; kind: string; sessionIds: string[] }>
  warnings: string[]
  routing: 'not-probed'
  processingSuccess: 'unknown'
}
const safe = (value: string) => value.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, '[url-omitted]').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 512)

/** Uses the same verified packages and listener function as InputRouter, without
 * definitions() quarantine writes, policy resolution, module imports or Session creation. */
export function botWorkflowProjection(options: {
  projectId: string
  store: Pick<BotInstanceStore, 'projectId' | 'ids' | 'get'>
  channels: Pick<ChannelManager, 'projectId' | 'botStatus'>
  directory: Pick<DirectoryBots, 'deployments' | 'inspect'>
  sessionIds: readonly string[]
  personalListeners: readonly InputListener[]
  sinkLookup?: (connectionId: string) => ConnectionSinkProjection
}): BotWorkflowProjection {
  const { projectId, store, channels, directory } = options
  if ([store.projectId, channels.projectId, directory.deployments.projectId].some(id => id !== projectId)) throw new Error('BOT projection Project mismatch')
  const result: BotWorkflowProjection = { connections: [], sinks: [], deployments: [], bindings: [], warnings: [], routing: 'not-probed', processingSuccess: 'unknown' }
  const index = store.ids(1000), deployments = directory.deployments.diagnosticIds()
  if (index.truncated) result.warnings.push('connection-index-limit')
  if (deployments.warning) result.warnings.push(deployments.warning)
  const sessions = new Set(options.sessionIds)
  for (const id of index.ids) {
    try {
      const status = channels.botStatus(id)
      if (status.projectId !== projectId) throw new Error('Project mismatch')
      result.connections.push({ id: safe(status.id), displayName: safe(status.displayName), platform: status.platform,
        purpose: status.purpose ?? 'unknown', enabled: status.enabled, health: status.state })
      try {
        const sink = options.sinkLookup?.(id) ?? connectionSinkProjection({ projectId, connectionId: id, platform: status.platform, histories: [], observations: [] })
        if (sink.projectId !== projectId || sink.connectionId !== id) throw new Error('Sink ownership mismatch')
        result.sinks.push(sink)
      } catch { result.warnings.push('connection-sink-unavailable') }
    } catch { result.warnings.push('connection-unavailable') }
  }
  for (const id of deployments.ids) {
    let item
    try { item = directory.inspect(id) } catch { result.warnings.push('deployment-unavailable'); continue }
    if (!item) continue
    const bot = item.bot
    result.deployments.push({ id: safe(id), state: item.state, ...(bot ? { mode: bot.mode, agent: bot.mode === 'personal' ? bot.agent : publishedBotAgentName(bot.id) } : {}),
      ...(item.deployment ? { revision: item.deployment.revision } : {}) })
    if (!bot) continue
    if (result.bindings.length >= 5000) { if (!result.warnings.includes('binding-index-limit')) result.warnings.push('binding-index-limit'); continue }
    if (bot.mode === 'personal') {
      const listeners = options.personalListeners.filter(listener => listener.source.id === bot.connection && listener.target.kind === 'session')
      result.bindings.push({ id: JSON.stringify([id, 'personal']), deploymentId: id, connectionId: bot.connection, platform: result.connections.find(c => c.id === bot.connection)?.platform ?? 'unknown',
        enabled: result.connections.find(c => c.id === bot.connection)?.enabled ?? false, subscribed: true, listener: listeners.length > 0, kind: 'host-owner-ingress',
        sessionIds: listeners.map(listener => listener.target.id).filter(id => sessions.has(id)) })
      continue
    }
    for (const binding of bot.bindings) {
      if (result.bindings.length >= 5000) { if (!result.warnings.includes('binding-index-limit')) result.warnings.push('binding-index-limit'); break }
      const topic = binding.platform !== 'discord' ? binding.conversationId : binding.observation ? binding.id
        : binding.target.kind === 'dm' ? `dm:${binding.target.userId}` : `guild:${binding.target.guildId}:channel:${binding.target.channelId}`
      const kind = binding.platform === 'discord' && binding.observation ? 'observation' : 'message'
      const listener = item.listeners?.some(listener => listener.source.id === binding.botInstanceId && listener.source.type === binding.platform && listener.topic === topic && listener.kind === kind) ?? false
      let sessionIds: string[] = []
      // Only link identities actually present in SessionManager; never prepare or
      // claim a guessed destination exists. Observation/thread sessions are not inferred.
      if (binding.platform !== 'discord' || !binding.observation && binding.target.kind === 'channel') {
        try {
          const connection = store.get(binding.botInstanceId)
          const sessionId = channelSessionId({ projectId, botInstanceId: binding.botInstanceId, platform: binding.platform, conversationId: binding.platform === 'discord' && binding.target.kind === 'channel' ? binding.target.channelId : binding.platform !== 'discord' ? binding.conversationId : '',
            ...(connection.legacySessionId ? { legacySessionId: true } : {}) })
          if (sessions.has(sessionId)) sessionIds = [sessionId]
        } catch { /* Missing connection cannot provide a verified session association. */ }
      }
      result.bindings.push({ id: createHash('sha256').update(JSON.stringify([id, binding.platform, binding.botInstanceId, topic])).digest('hex'), deploymentId: id, connectionId: safe(binding.botInstanceId),
        platform: binding.platform, topic: safe(topic), enabled: binding.enabled, subscribed: bindingSubscribed(bot, binding), listener, kind, sessionIds })
    }
  }
  return result
}
