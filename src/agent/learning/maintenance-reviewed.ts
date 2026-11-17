import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { archivePathSchema, canonical, checksum, revisionSchema } from './maintenance-contracts.ts'
import { snapshotRevision, type MaintenanceSnapshot } from './maintenance-foundation.ts'

/** A content review is not an ownership receipt and never authorizes execution. */
export const reviewedDocumentSchema = z.object({
  path: archivePathSchema, sourceRevision: revisionSchema,
  snapshotRevision: revisionSchema, sourceTextDigest: revisionSchema,
  disposition: z.enum(['archive', 'seed']),
}).strict()
export const reviewedPreviewRequest = z.object({
  documents: z.array(reviewedDocumentSchema).min(1).max(1000),
  historyEffect: z.literal('none'),
}).strict()
export const documentInspectionRequest = z.object({ paths: z.array(archivePathSchema).min(1).max(1000) }).strict()
export interface DocumentObservation {
  sourceRevision: string
  snapshot: MaintenanceSnapshot
}
export interface ReviewedDocumentSources {
  /** Host protection policy must run on every read, including the final recheck. */
  observeDocument(path: string): DocumentObservation
}
export const reviewSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1), scopeHash: revisionSchema,
  reviewTextDigest: revisionSchema, authority: z.literal('host-content-review'),
}).strict()
export type HostContentReview = z.infer<typeof reviewSchema>

export function reviewedDocumentScope(projectId: string, documents: z.infer<typeof reviewedDocumentSchema>[]) {
  return { version: 1 as const, projectId, documents: [...documents].sort((a, b) => a.path.localeCompare(b.path)),
    effects: { history: 'none' as const, epoch: 'unchanged' as const,
      unselectedDocuments: 'unchanged' as const, sourceLogs: 'unchanged' as const } }
}

/** Read-only production path. It does NOT reuse the automatic-provenance
 * manifest: selected mixed/unknown content stays unknown. No journal, seed
 * replacement, epoch, history capture or persistent operation is created. */
export class ReviewedMaintenancePreview {
  constructor(private readonly projectId: string, private readonly sources: ReviewedDocumentSources) {}

  inspect(raw: unknown) {
    const { paths } = documentInspectionRequest.parse(raw)
    if (new Set(paths).size !== paths.length) throw new Error('Duplicate document path')
    return paths.map(path => {
      const observed = this.sources.observeDocument(path)
      const member = path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
      const text = observed.snapshot.files[member]
      if (text === undefined) throw new Error('Missing source text in complete snapshot')
      return { path, sourceRevision: observed.sourceRevision,
        snapshotRevision: snapshotRevision(observed.snapshot), sourceTextDigest: checksum(Buffer.from(text, 'base64')),
        provenance: 'unknown' as const }
    }).sort((a, b) => a.path.localeCompare(b.path))
  }

  preview(raw: unknown, hostReview?: HostContentReview) {
    const request = reviewedPreviewRequest.parse(raw)
    const documents = [...request.documents].sort((a, b) => a.path.localeCompare(b.path))
    const observed = this.inspect({ paths: documents.map(item => item.path) })
    for (const [index, document] of documents.entries()) {
      const { disposition: _, ...expected } = document
      const { provenance: __, ...actual } = observed[index]!
      if (canonical(expected) !== canonical(actual)) throw new Error('Reviewed document revision changed; inspect and review again')
    }
    const scope = reviewedDocumentScope(this.projectId, documents)
    const scopeHash = checksum(canonical(scope))
    const review = hostReview === undefined ? undefined : reviewSchema.parse(hostReview)
    if (review && (review.projectId !== this.projectId || review.scopeHash !== scopeHash)) throw new Error('Foreign or stale content review scope')
    // The host (not the HTTP body) may attach a separate human review receipt.
    // Even a matching receipt is NOT an execution confirmation.
    const value = { ...scope, scopeHash, operationId: randomUUID(),
      contentReview: review ?? null, executionApproval: 'required-separately' as const,
      provenance: 'unknown' as const, activation: 'disabled' as const,
      integration: 'partial' as const }
    // Read again: a source changed during planning must not produce a valid plan.
    if (canonical(observed) !== canonical(this.inspect({ paths: documents.map(item => item.path) }))) throw new Error('Documents changed during preview')
    return { ...value, planRevision: checksum(canonical(value)) }
  }
}
