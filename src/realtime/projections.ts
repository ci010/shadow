import { createHash } from 'node:crypto'

import type { ProjectionTopic, ProjectionPayload } from './projection-wire.ts'
export { projectionKinds } from './projection-wire.ts'
export type { ProjectionKind, ProjectionTopic, ProjectionReader, ProjectionSnapshot, ProjectionDelta, ProjectionPayload } from './projection-wire.ts'
export function projectionRevision(data: unknown): string {
  return createHash('sha256').update(JSON.stringify(data)).digest('hex')
}
export function projectionPayload(topic: ProjectionTopic, data: unknown, previous?: { revision: string; data: unknown }): ProjectionPayload {
  const revision = projectionRevision(data)
  const field = topic.kind === 'session-summary' ? 'sessions' : topic.kind === 'io-runs' ? 'runs' : undefined
  const key = topic.kind === 'session-summary' ? 'sessionId' : 'id'
  if (field && previous) {
    const rows = (value: unknown) => (value as Record<string, Array<Record<string, unknown>>>)[field]
    const before = new Map(rows(previous.data).map(row => [String(row[key]), row]))
    const after = new Map(rows(data).map(row => [String(row[key]), row]))
    return { event: 'delta', base: previous.revision, revision,
      upsert: [...after].filter(([id, row]) => !before.has(id) || JSON.stringify(before.get(id)) !== JSON.stringify(row)).map(([, row]) => row),
      removed: [...before.keys()].filter(id => !after.has(id)) }
  }
  return { event: 'snapshot', revision, data }
}
