import { createHash } from 'node:crypto'
import type { BotWorkflowProjection } from './workflow-projection.ts'
import { parseConnectionSinkProjection } from '../shared/connection-sink.ts'

export type ObservationKind = 'connection' | 'receiver' | 'deployment' | 'binding'
/** Shared by inventory, exact VFS lookup and admission. No caller-supplied paths. */
export function observationLocator(projectId: string, kind: ObservationKind, id: string, connectionId?: string) {
  if (kind === 'receiver' && !connectionId) throw new TypeError('Receiver locator requires Connection identity')
  const opaque = createHash('sha256').update(JSON.stringify([projectId, kind, connectionId ?? null, id])).digest('hex')
  return { objectKind: kind, id: opaque, path: `v:connections/observations/${kind}/${opaque}.json` }
}
const unknownEvidence = { discovery: 'unknown', sessionMetadata: 'unknown', received: 'unknown', persisted: 'unknown', bound: 'unknown', executed: 'unknown' } as const

/** Same evidence as the UI, without its presentation/navigation identifiers.
 * Reconstruct every field: never spread runtime config, names, topics or Sessions.
 * This is inventory, not per-message tracing, admission or a management capability.
 */
export function botObservation(projectId: string, source: BotWorkflowProjection) {
  const sinks = source.sinks.map(sink => parseConnectionSinkProjection(sink, projectId))
  return {
    projectId,
    connections: source.connections.map(connection => ({ ...observationLocator(projectId, 'connection', connection.id), platform: connection.platform,
      enabled: connection.enabled, health: connection.health,
      receivers: (sinks.find(sink => sink.connectionId === connection.id)?.receivers ?? []).map(receiver => ({
        ...observationLocator(projectId, 'receiver', receiver.id, connection.id), connectionId: observationLocator(projectId, 'connection', connection.id).id, connectionPath: observationLocator(projectId, 'connection', connection.id).path, evidence: receiver.evidence ?? unknownEvidence,
      })),
    })),
    deployments: source.deployments.map(deployment => ({ ...observationLocator(projectId, 'deployment', deployment.id), state: deployment.state, mode: deployment.mode, revision: deployment.revision })),
    bindings: source.bindings.map(binding => ({ ...observationLocator(projectId, 'binding', binding.id), deploymentId: observationLocator(projectId, 'deployment', binding.deploymentId).id,
      deploymentPath: observationLocator(projectId, 'deployment', binding.deploymentId).path,
      connectionId: observationLocator(projectId, 'connection', binding.connectionId).id, connectionPath: observationLocator(projectId, 'connection', binding.connectionId).path, enabled: binding.enabled, subscribed: binding.subscribed,
      listener: binding.listener, kind: binding.kind, sessionCount: binding.sessionIds.length,
      admission: 'unknown' as const, executed: 'unknown' as const })),
    routing: 'not-probed' as const, processingSuccess: 'unknown' as const,
    incomplete: source.warnings.length > 0,
  }
}

/** Only reconstructed redacted records, never raw projection/configuration paths. */
export function observationEntries(projectId: string, source: BotWorkflowProjection) {
  const snapshot = botObservation(projectId, source)
  const records = [...snapshot.connections.flatMap(connection => [connection, ...connection.receivers]), ...snapshot.deployments, ...snapshot.bindings]
  return records.map(record => ({ name: record.path.slice('v:connections/'.length),
    content: JSON.stringify({ projectId, ...record, view: 'current-observation', revisionPolicy: 'Current published state only; compare revision with the frozen reference. Missing objects are unavailable, never historical replay.',
      routing: snapshot.routing, processingSuccess: snapshot.processingSuccess, incomplete: snapshot.incomplete }, null, 2) }))
}
