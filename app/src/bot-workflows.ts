import { z } from 'zod'
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
  bindings: z.array(z.object({ id: text, deploymentId: text, connectionId: text, platform: text, topic: text.optional(), enabled: z.boolean(), subscribed: z.boolean(), listener: z.boolean(), kind: text, sessionIds: z.array(text).max(1000) }).strict()).max(5000),
  warnings: z.array(text), routing: z.literal('not-probed'), processingSuccess: z.literal('unknown'),
}).strict()
export type BotProjection = z.infer<typeof projection>
export const parseBotProjection = (raw: unknown): BotProjection => projection.parse(raw)
export function botCanvas(bots?: BotProjection): WorkflowCanvasEntry[] {
  if (!bots) return []
  // Unbound connections and quarantined packages remain inspectable as actual
  // inventory, not invented bindings or Workflow runtime definitions.
  const rows = [
    ...bots.bindings.map(binding => ({ id: `bot-binding:${binding.id}`, binding, connection: bots.connections.find(c => c.id === binding.connectionId), deployment: bots.deployments.find(d => d.id === binding.deploymentId) })),
    ...bots.connections.filter(c => !bots.bindings.some(b => b.connectionId === c.id)).map(connection => ({ id: `bot-connection:${connection.id}`, connection, binding: undefined, deployment: undefined })),
    ...bots.deployments.filter(d => !bots.bindings.some(b => b.deploymentId === d.id)).map(deployment => ({ id: `bot-deployment:${deployment.id}`, deployment, binding: undefined, connection: undefined })),
  ]
  return rows.map(({ id, binding, connection, deployment }) => {
    const enabled = !!connection?.enabled && deployment?.state === 'valid' && !!binding?.enabled && binding.subscribed
    const node = (id: string, label: string, detail: string, config: unknown, targetSessionId?: string) => ({ id, label, detail, config, status: 'ready' as const, targetSessionId })
    const graph = connection || binding ? [node('connection', t('BOT connection'), connection ? `${connection.displayName} · ${connection.platform} · ${healthLabel(connection.health)} · ${connection.enabled ? t('Enabled') : t('Disabled')}` : t('Connection unavailable'), connection ?? { id: binding?.connectionId })] : []
    if (binding) graph.push(node('binding', t('Conversation binding'), `${binding.topic ?? t('Host owner ingress')} · ${binding.enabled ? t('Enabled') : t('Disabled')} · ${binding.subscribed ? t('Subscribed') : t('Not subscribed')} · ${binding.listener ? t('Listener projected') : t('No listener')}`, binding))
    if (deployment) graph.push(node('deployment', t('Published BOT / Agent'), `${deployment.id} · ${deployment.agent ?? t('Unavailable')} · ${deploymentLabel(deployment.state)}`, deployment))
    if (binding) graph.push(node('session', t('Session'), binding.sessionIds.length ? binding.sessionIds.join(', ') : t('No existing session recorded'), { sessionIds: binding.sessionIds }, binding.sessionIds[0]))
    return { definition: { id, name: binding ? `${deployment?.id ?? binding.deploymentId} · ${binding.topic ?? t('Host owner ingress')}` : connection?.displayName ?? deployment!.id, enabled }, graph, enabled, projection: true,
      conversation: binding?.sessionIds[0] ? { kind: 'fixed', sessionId: binding.sessionIds[0] } : undefined }
  })
}
