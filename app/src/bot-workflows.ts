import { z } from 'zod'
import { connectionSinkProjectionSchema } from '../../src/shared/connection-sink.ts'
import { connectionSinkCanvas } from './connection-sinks.ts'
import { conversationTargetLabel } from './receiver-label.ts'
import { t } from './i18n.ts'
import { channelStateLabel } from './channel-settings.ts'
import type { WorkflowCanvasEntry } from './workflow-canvas.ts'

const text = z.string().max(512)
const health = z.enum(['disabled', 'unconfigured', 'connecting', 'connected', 'disconnected', 'error', 'running', 'restart-required'])
const healthLabel = (state: z.infer<typeof health>) => channelStateLabel({ state, configured: true })
const deploymentLabel = (state: 'valid' | 'quarantined' | 'unavailable') => state === 'valid' ? t('Validated package') : state === 'quarantined' ? t('Quarantined package') : t('Unavailable')
const projection = z.object({
  connections: z.array(z.object({ id: text, displayName: text, platform: text, purpose: text, enabled: z.boolean(), health }).strict()).max(1000),
  deployments: z.array(z.object({ id: text, state: z.enum(['valid', 'quarantined', 'unavailable']), mode: z.enum(['personal', 'service']).optional(), agent: text.optional(), revision: text.optional() }).strict()).max(1024),
  bindings: z.array(z.object({ id: text, deploymentId: text, connectionId: text, platform: text, topic: text.optional(), enabled: z.boolean(), subscribed: z.boolean(), listener: z.boolean(), kind: text, sessionIds: z.array(text).max(1000), receiverIds: z.array(text).max(1000).optional() }).strict()).max(5000),
  sinks: z.array(connectionSinkProjectionSchema).max(1000).optional(),
  warnings: z.array(text), routing: z.literal('not-probed'), processingSuccess: z.literal('unknown'),
}).strict()
export type BotProjection = z.infer<typeof projection>
export const parseBotProjection = (raw: unknown, projectId?: string): BotProjection => {
  const value = projection.parse(raw)
  if (projectId && value.sinks?.some(sink => sink.projectId !== projectId)) throw new Error('Connection sink Project ownership mismatch.')
  return value
}
export function botCanvas(bots?: BotProjection): WorkflowCanvasEntry[] {
  if (!bots) return []
  type Binding = BotProjection['bindings'][number]
  type Deployment = BotProjection['deployments'][number]
  type Graph = NonNullable<WorkflowCanvasEntry['graph']>
  const result: WorkflowCanvasEntry[] = []
  const addBot = (graph: Graph, binding: Binding | undefined, deployment: Deployment | undefined, parentId?: string, receiverId?: string) => {
    const id = binding ? `bot:${binding.id}` : 'deployment'
    graph.push({ id, nodeType: 'deployment', parentId, receiverId, label: t('Published BOT / Agent'),
      detail: `${deployment?.agent ?? t('Unavailable')} · ${deployment ? deploymentLabel(deployment.state) : t('Unavailable')}`,
      config: { ...binding, deployment: deployment ?? null, admission: 'unknown', executed: 'unknown' }, status: 'unknown',
      description: binding?.kind === 'host-owner-ingress' ? t('Owner ingress is not permission to reply in every group. Admission and execution are unknown.')
        : t('Configuration and existing sessions are not message admission or execution receipts.') })
    return id
  }
  for (const connection of [...bots.connections, ...(bots.sinks ?? []).filter(sink => !bots.connections.some(connection => connection.id === sink.connectionId)).map(sink => ({ id: sink.connectionId, displayName: sink.connectionId, platform: 'unknown', enabled: false, health: 'disconnected' as const }))]) {
    const sink = bots.sinks?.find(sink => sink.connectionId === connection.id)
    const base = sink ? connectionSinkCanvas(sink, sink.projectId, connection.displayName) : undefined
    const graph: Graph = base?.graph?.map(node => ({ ...node, parentId: node.id === 'connection' ? undefined : 'connection' })) ?? [{ id: 'connection', nodeType: 'connection', label: t('Connection'), detail: `${connection.platform} · ${healthLabel(connection.health)}`, config: connection, status: 'unknown' }]
    // Empty receipt is an explanation, not a fictional receiver node.
    const empty = graph.findIndex(node => node.id === 'sink'); if (empty >= 0) graph.splice(empty, 1)
    const aliases: Record<string, string> = { [`bot-connection:${connection.id}`]: 'connection' }
    for (const binding of bots.bindings.filter(binding => binding.connectionId === connection.id)) {
      // Match only the wire identity explicitly represented by this projection.
      // Discord guild/channel selectors carry a channel ID; observation IDs and
      // owner ingress alone never imply a receiver association.
      const channel = binding.platform === 'discord' && binding.kind === 'message' ? /^guild:([^:]+):channel:([^:]+)$/.exec(binding.topic ?? '') : undefined
      const ownerReceivers = binding.kind === 'host-owner-ingress' ? sink?.receivers.filter(receiver => receiver.kind === 'direct' && receiver.address.platform === binding.platform && binding.receiverIds?.includes(receiver.id)) ?? [] : []
      const receiver = binding.kind === 'host-owner-ingress' ? (ownerReceivers.length === 1 ? ownerReceivers[0] : undefined)
        : binding.kind === 'message' ? sink?.receivers.find(receiver => receiver.address.platform === binding.platform &&
          (binding.platform === 'discord' ? !!channel && receiver.address.conversationId === channel[2] &&
            (receiver.guildId ?? (receiver.navigation.kind === 'channel-content' ? receiver.navigation.guildId : undefined)) === channel[1]
            : receiver.address.conversationId === binding.topic)) : undefined
      // Owner ingress is BOT configuration, not a fictional receiver. Without an
      // exact metadata-backed owner DM leave the BOT at its connection root.
      const parentId = receiver ? `receiver:${receiver.id}` : binding.kind === 'host-owner-ingress' ? 'connection' : `entry:${binding.id}`
      if (!receiver && binding.kind !== 'host-owner-ingress') graph.push({ id: parentId, nodeType: 'sink', parentId: 'connection', label: configuredTarget(binding),
        detail: t('Configured entry; receipt unknown'), config: { kind: binding.kind, topic: binding.topic, received: 'unknown' }, status: 'unknown',
        description: t('Configured entry; receipt unknown') })
      const botId = addBot(graph, binding, bots.deployments.find(deployment => deployment.id === binding.deploymentId), parentId, receiver?.id)
      aliases[`bot-binding:${binding.id}`] = botId
    }
    result.push({ definition: { id: sink?.id ?? `connection:${connection.id}`, name: connection.displayName, enabled: connection.enabled }, graph,
      enabled: connection.enabled, projection: true, topology: true, selectionAliases: aliases, sinkProjection: sink,
      connectionSettingsId: bots.connections.some(item => item.id === connection.id) ? connection.id : undefined, configureConnectionId: bots.connections.some(item => item.id === connection.id) ? connection.id : undefined })
  }
  // Missing transport references remain diagnosable but never attach to a
  // different connector simply because it has the same display name.
  for (const binding of bots.bindings.filter(binding => !bots.connections.some(connection => connection.id === binding.connectionId) && !bots.sinks?.some(sink => sink.connectionId === binding.connectionId))) {
    const graph: Graph = [{ id: 'connection', nodeType: 'connection', label: t('Connection'), detail: t('Connection unavailable'), config: { id: binding.connectionId }, status: 'unknown' },
      { id: `entry:${binding.id}`, nodeType: 'sink', parentId: 'connection', label: configuredTarget(binding), detail: t('Configured entry; receipt unknown'), config: binding, status: 'unknown' }]
    if (binding.kind === 'host-owner-ingress') graph.splice(1, 1)
    addBot(graph, binding, bots.deployments.find(deployment => deployment.id === binding.deploymentId), binding.kind === 'host-owner-ingress' ? 'connection' : `entry:${binding.id}`)
    result.push({ definition: { id: `bot-binding:${binding.id}`, name: t('Connection unavailable'), enabled: false }, graph, projection: true, topology: true, enabled: false,
      conversation: binding.sessionIds[0] ? { kind: 'fixed', sessionId: binding.sessionIds[0] } : undefined })
  }
  for (const deployment of bots.deployments.filter(deployment => !bots.bindings.some(binding => binding.deploymentId === deployment.id))) {
    const graph: Graph = []; addBot(graph, undefined, deployment)
    result.push({ definition: { id: `bot-deployment:${deployment.id}`, name: deployment.agent ?? t('Published BOT / Agent'), enabled: false }, graph, projection: true, enabled: false })
  }
  return result
}

export function configuredTarget(binding: Pick<BotProjection['bindings'][number], 'platform' | 'topic' | 'kind'>): string {
  if (binding.kind === 'host-owner-ingress') return t('Owner message target unavailable')
  const channel = binding.platform === 'discord' ? /^guild:([^:]+):channel:([^:]+)$/.exec(binding.topic ?? '') : undefined
  if (channel) return `${conversationTargetLabel(binding.platform, channel[2]!, 'channel')} · ${t('Guild')} ${channel[1]}`
  return binding.topic ? conversationTargetLabel(binding.platform, binding.topic) : t('Configured target unavailable')
}
