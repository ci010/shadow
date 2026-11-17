import { readDocumentMaintenanceSnapshot } from './maintenance-documents.ts'
import { MaintenanceGate } from './maintenance-gate.ts'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { archivePathSchema, canonical, checksum, revisionSchema, type ArchiveCandidate } from './maintenance-contracts.ts'
import { LearningMaintenanceFoundation, type MaintenanceSources } from './maintenance-foundation.ts'
import type { ProtectedMaintenanceSource } from './maintenance-sources.ts'
import { ReviewedMaintenancePreview, type ReviewedDocumentSources } from './maintenance-reviewed.ts'

interface PreviewSources extends MaintenanceSources {
  protectedSources?(): Promise<ProtectedMaintenanceSource[]>
  observeDocument?: ReviewedDocumentSources['observeDocument']
}

const selection = z.object({ path: archivePathSchema, sourceRevision: revisionSchema, snapshotRevision: revisionSchema }).strict()
export const maintenancePreviewRequest = z.object({ candidates: z.array(selection).max(1000), seeds: z.array(selection).max(1000) }).strict()
export const maintenanceApplyRequest = z.object({ operationId: z.string().uuid(), manifestRevision: revisionSchema }).strict()
export const maintenanceIntegrationBlockers = Object.freeze([
  'http-apply-has-no-live-human-confirmation-use-separate-owner-tool',
  'already-imported-session-skill-invalidation', 'resource-bearing-skill-packages',
  'optional-epoch-history-policy-not-approved', 'external-os-writers-not-fenced',
])

/** Production preview integration only. No prepare/recovery/startup side effects.
 * Apply cannot reach foundation.prepare or any live content mutation. */
export class LearningMaintenancePreview {
  constructor(private readonly home: string, private readonly projectId: string, private readonly sources: PreviewSources) {}
  status() {
    return { integration: 'partial' as const, activation: 'disabled' as const,
      blockers: [...maintenanceIntegrationBlockers], documentGate: new MaintenanceGate(this.home).status(), foundation: new LearningMaintenanceFoundation(this.home, this.projectId, this.sources).status() }
  }
  async candidates() {
    return { activation: 'disabled' as const, candidates: (await this.sources.candidates()).map(({ path, sourceRevision, snapshotRevision }) => ({ path, sourceRevision, snapshotRevision })),
      protectedSources: await this.sources.protectedSources?.() ?? [] }
  }
  readDocumentSnapshot(revision: string) { return readDocumentMaintenanceSnapshot(this.home, revision) }
  inspectDocuments(raw: unknown) {
    return this.reviewedDocuments().inspect(raw)
  }
  private reviewedDocuments() {
    if (!this.sources.observeDocument) throw new Error('Document observation adapter unavailable')
    return new ReviewedMaintenancePreview(this.projectId, { observeDocument: path => this.sources.observeDocument!(path) })
  }
  previewDocuments(raw: unknown) {
    // No HTTP entrypoint accepts a host content-review receipt.
    return this.reviewedDocuments().preview(raw)
  }
  async preview(raw: unknown) {
    const request = maintenancePreviewRequest.parse(raw)
    const all = await this.sources.candidates()
    const seen = new Set<string>()
    const resolve = (selected: z.infer<typeof selection>[]): ArchiveCandidate[] => selected.map(item => {
      if (seen.has(item.path)) throw new Error('Duplicate or overlapping seed/candidate selection')
      seen.add(item.path)
      const candidate = all.find(candidate => candidate.path === item.path && candidate.sourceRevision === item.sourceRevision && candidate.snapshotRevision === item.snapshotRevision)
      if (!candidate) throw new Error('Selected path/revision has no current automatic receipt; refresh candidates')
      return candidate
    })
    const selected = resolve(request.candidates), seeds = resolve(request.seeds)
    // Capture only the explicitly selected retirement set. The host revalidates
    // real receipts; no HTTP field can mint provenance or choose an epoch.
    const selectedPaths = new Set(selected.map(candidate => candidate.path))
    const sources: MaintenanceSources = { history: this.sources.history,
      candidates: async () => (await this.sources.candidates()).filter(candidate => selectedPaths.has(candidate.path)),
      snapshot: candidate => this.sources.snapshot(candidate) }
    const plan = await new LearningMaintenanceFoundation(this.home, this.projectId, sources).preview({ operationId: randomUUID(), createdAt: new Date().toISOString(), fromEpoch: 0 })
    if (canonical(plan.manifest.candidates) !== canonical(selected.sort((a, b) => a.path.localeCompare(b.path)))) throw new Error('Selected sources changed during preview')
    const after = await this.sources.candidates()
    for (const seed of seeds) if (!after.some(candidate => canonical(candidate) === canonical(seed))) throw new Error('Seed revision changed during preview')
    const value = { manifest: plan.manifest, foundationRevision: plan.revision, seeds: seeds.sort((a, b) => a.path.localeCompare(b.path)) }
    return { ...value, manifestRevision: checksum(canonical(value)), activation: 'disabled' as const, integration: 'partial' as const }
  }
  apply(raw: unknown): never {
    maintenanceApplyRequest.parse(raw)
    throw new Error('Learning maintenance apply disabled: runtime integration is partial; no state or source was changed')
  }
}
