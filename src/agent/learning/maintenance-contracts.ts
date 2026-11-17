import { createHash } from 'node:crypto'
import { z } from 'zod'

export const checksum = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex')
/** Canonical JSON for maintenance receipts, not a session serialization format. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const encoded = JSON.stringify(value)
    if (encoded === undefined || (typeof value === 'number' && !Number.isFinite(value))) throw new Error('Non-JSON maintenance value')
    return encoded
  }
  if (Array.isArray(value)) return `[${Array.from(value, canonical).join(',')}]`
  if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new Error('Expected plain JSON object')
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`
}
export const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/)
const identifier = z.string().min(1).max(2048).refine(value => !/[\x00-\x1f]/u.test(value))
const slug = '[a-z0-9]+(?:-[a-z0-9]+)*'
export const archivePathSchema = z.string().max(512).regex(new RegExp(
  `^(?:memory/(?:topics|concepts|tools|decisions)/${slug}\\.md|skills/${slug}/SKILL\\.md)$`,
))
/** Only trusted adapters may attest provenance. Request bodies must never mint it. */
export const candidateSchema = z.object({
  projectId: identifier,
  path: archivePathSchema,
  // Native source revision: preserve the existing automatic artifact receipt's hash domain.
  sourceRevision: revisionSchema,
  // Independent canonical complete snapshot envelope hash; never substitute for the receipt.
  snapshotRevision: revisionSchema,
  provenance: z.object({
    kind: z.literal('automatic-learning'),
    batchId: z.string().uuid(),
    artifactRevision: revisionSchema,
    manual: z.literal(false),
    builtin: z.literal(false),
  }).strict(),
}).strict().superRefine((value, context) => {
  if (value.sourceRevision !== value.provenance.artifactRevision) {
    context.addIssue({ code: 'custom', message: 'Current revision lacks exact automatic provenance' })
  }
})
export type ArchiveCandidate = z.infer<typeof candidateSchema>
export const cutoffSchema = z.object({
  sessionId: identifier, physicalId: identifier, segmentIndex: z.number().int().nonnegative(),
  messageCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  prefixRevision: revisionSchema,
}).strict()
export type MaintenanceCutoff = z.infer<typeof cutoffSchema>
export const manifestSchema = z.object({
  version: z.literal(1), projectId: identifier, operationId: z.string().uuid(),
  createdAt: z.string().datetime({ offset: true }),
  fromEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 2),
  toEpoch: z.number().int().positive().max(Number.MAX_SAFE_INTEGER - 1),
  inventoryRevision: revisionSchema,
  candidates: z.array(candidateSchema).max(1000), cutoffs: z.array(cutoffSchema).max(100000),
}).strict().superRefine((value, context) => {
  if (value.toEpoch !== value.fromEpoch + 1) context.addIssue({ code: 'custom', message: 'Epoch must advance by one' })
  const paths = new Set<string>(), physical = new Set<string>(), segments = new Set<string>()
  const sessionSegments = new Map<string, number[]>()
  for (const candidate of value.candidates) {
    if (candidate.projectId !== value.projectId || paths.has(candidate.path)) context.addIssue({ code: 'custom', message: 'Foreign or duplicate candidate' })
    paths.add(candidate.path)
  }
  for (const cutoff of value.cutoffs) {
    const segment = canonical([cutoff.sessionId, cutoff.segmentIndex])
    if (physical.has(cutoff.physicalId) || segments.has(segment)) context.addIssue({ code: 'custom', message: 'Duplicate physical history' })
    physical.add(cutoff.physicalId); segments.add(segment)
    const indices = sessionSegments.get(cutoff.sessionId) ?? []
    indices.push(cutoff.segmentIndex); sessionSegments.set(cutoff.sessionId, indices)
  }
  for (const indices of sessionSegments.values()) {
    indices.sort((a, b) => a - b)
    if (indices.some((index, position) => index !== position)) context.addIssue({ code: 'custom', message: 'Missing physical segment' })
  }
})
export type MaintenanceManifest = z.infer<typeof manifestSchema>
export function manifestRevision(value: MaintenanceManifest): string { return checksum(canonical(manifestSchema.parse(value))) }

const inventorySchema = z.object({
  projectId: identifier, revision: revisionSchema,
  // An empty inventory must be explicitly attested, never inferred from an exception.
  complete: z.literal(true),
  sessions: z.array(z.object({
    sessionId: identifier, updatedAt: z.string().datetime({ offset: true }),
    segments: z.array(z.object({ physicalId: identifier, segmentIndex: z.number().int().nonnegative() }).strict()).min(1),
  }).strict()),
}).strict()
export type HistoryInventory = z.infer<typeof inventorySchema>
export interface MaintenanceHistory {
  /** Full persisted inventory (including unloaded/old sessions), not listSessions/current segment. */
  inventory(): Promise<HistoryInventory>
  /** Missing/unreadable segments must throw. Includes all persisted messages in this physical segment. */
  messages(sessionId: string, physicalId: string): Promise<readonly unknown[]>
}
export async function captureCutoffs(projectId: string, history: MaintenanceHistory): Promise<{
  inventoryRevision: string; cutoffs: MaintenanceCutoff[]
}> {
  const inventory = inventorySchema.parse(await history.inventory())
  if (inventory.projectId !== projectId) throw new Error('Foreign history inventory')
  const cutoffs: MaintenanceCutoff[] = [], sessions = new Set<string>()
  for (const session of inventory.sessions) {
    if (sessions.has(session.sessionId)) throw new Error('Duplicate session inventory')
    sessions.add(session.sessionId)
    const segments = [...session.segments].sort((a, b) => a.segmentIndex - b.segmentIndex)
    if (segments.some((segment, index) => segment.segmentIndex !== index)) throw new Error('Missing physical segment')
    for (const segment of segments) {
      const messages = await history.messages(session.sessionId, segment.physicalId)
      if (!Array.isArray(messages)) throw new Error('Missing physical history')
      cutoffs.push(cutoffSchema.parse({ sessionId: session.sessionId, ...segment,
        messageCount: messages.length, prefixRevision: checksum(canonical(messages)) }))
    }
  }
  const after = inventorySchema.parse(await history.inventory())
  if (canonical(inventory) !== canonical(after)) throw new Error('History inventory changed during capture')
  // Validate duplicate physical IDs across sessions, too.
  if (new Set(cutoffs.map(cutoff => cutoff.physicalId)).size !== cutoffs.length) throw new Error('Duplicate physical history')
  return { inventoryRevision: inventory.revision, cutoffs }
}

/** Prefix integrity, not a timestamp or a sentinel cursor. Later appends remain outside the cutoff. */
export async function verifyCutoffs(cutoffs: MaintenanceCutoff[], history: MaintenanceHistory): Promise<void> {
  for (const raw of cutoffs) {
    const cutoff = cutoffSchema.parse(raw)
    const messages = await history.messages(cutoff.sessionId, cutoff.physicalId)
    if (!Array.isArray(messages) || messages.length < cutoff.messageCount
      || checksum(canonical(messages.slice(0, cutoff.messageCount))) !== cutoff.prefixRevision) throw new Error('Historical prefix conflict')
  }
}
