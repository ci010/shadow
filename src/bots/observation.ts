import { createHash } from 'node:crypto'
import type { BotWorkflowProjection } from './workflow-projection.ts'
import { parseConnectionSinkProjection } from '../shared/connection-sink.ts'

const opaque = (id: string) => createHash('sha256').update(id).digest('hex')
const unknownEvidence = { discovery: 'unknown', sessionMetadata: 'unknown', received: 'unknown', persisted: 'unknown', bound: 'unknown', executed: 'unknown' } as const

/** Same evidence as the UI, without its presentation/navigation identifiers.
 * Reconstruct every field: never spread runtime config, names, topics or Sessions.
 * This is inventory, not per-message tracing, admission or a management capability.
 */
export function botObservation(projectId: string, source: BotWorkflowProjection) {
  const sinks = source.sinks.map(sink => parseConnectionSinkProjection(sink, projectId))
  return {
    projectId,
    connections: source.connections.map(connection => ({ id: opaque(connection.id), platform: connection.platform,
      enabled: connection.enabled, health: connection.health,
      receivers: (sinks.find(sink => sink.connectionId === connection.id)?.receivers ?? []).map(receiver => ({
        id: opaque(receiver.id), evidence: receiver.evidence ?? unknownEvidence,
      })),
    })),
    deployments: source.deployments.map(deployment => ({ id: opaque(deployment.id), state: deployment.state, mode: deployment.mode })),
    bindings: source.bindings.map(binding => ({ id: opaque(binding.id), deploymentId: opaque(binding.deploymentId),
      connectionId: opaque(binding.connectionId), enabled: binding.enabled, subscribed: binding.subscribed,
      listener: binding.listener, kind: binding.kind, sessionCount: binding.sessionIds.length,
      admission: 'unknown' as const, executed: 'unknown' as const })),
    routing: 'not-probed' as const, processingSuccess: 'unknown' as const,
    incomplete: source.warnings.length > 0,
  }
}
