/** Fixed read models only; this is deliberately not a generic HTTP/RPC tunnel. */
export const projectionKinds = ['session-summary', 'session-stages', 'io-runs', 'folders', 'folder-devices', 'nodes', 'channels', 'service-groups'] as const
export type ProjectionKind = typeof projectionKinds[number]
export type ProjectionTopic = { kind: 'session-summary'; projectId: string; scope: 'navigation' | 'full' }
  | { kind: Exclude<ProjectionKind, 'session-summary'>; projectId: string }
export type ProjectionReader = (topic: ProjectionTopic) => unknown | Promise<unknown>
export type ProjectionSnapshot = { event: 'snapshot'; revision: string; data: unknown }
export type ProjectionDelta = { event: 'delta'; base: string; revision: string; upsert: unknown[]; removed: string[] }
export type ProjectionPayload = ProjectionSnapshot | ProjectionDelta
