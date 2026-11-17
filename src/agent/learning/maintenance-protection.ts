import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { Journal } from '../../watermarks/journal.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { readSafe, safePath } from '../../knowledge/service.ts'
import { archivePathSchema, canonical, checksum, revisionSchema } from './maintenance-contracts.ts'
import { snapshotSchema, snapshotRevision } from './maintenance-foundation.ts'

export const protectionClassification = z.object({ path: archivePathSchema, sourceRevision: revisionSchema,
  snapshotRevision: revisionSchema, sourceTextDigest: revisionSchema,
  disposition: z.enum(['retain', 'protected', 'archive', 'seed']), replacementText: z.string().optional() }).strict()
const schema = z.object({ version: z.literal(1), projectId: z.string().min(1), generation: z.number().int().nonnegative(),
  protectedPaths: z.array(archivePathSchema), inventoryRevision: revisionSchema, contentPlanRevision: revisionSchema,
  classifications: z.array(protectionClassification), originals: z.record(archivePathSchema, snapshotSchema),
  decisionReference: z.string().min(1).max(2000), previousRevision: revisionSchema.nullable(),
  coverage: z.literal('supported-single-documents-only-unlisted-unsupported-new-or-changed-protected'),
  provenance: z.literal('unknown-not-attested-by-human-classification'),
}).strict().superRefine((state, context) => {
  if (new Set(state.classifications.map(item => item.path)).size !== state.classifications.length ||
    canonical(state.classifications.map(item => item.path).sort()) !== canonical(Object.keys(state.originals).sort())) context.addIssue({ code: 'custom', message: 'Incomplete or duplicate protection classification' })
  for (const document of state.classifications) {
    const original = state.originals[document.path], member = document.path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
    if (!original || snapshotRevision(original) !== document.snapshotRevision || !original.files[member] ||
      checksum(Buffer.from(original.files[member], 'base64')) !== document.sourceTextDigest ||
      (document.disposition === 'seed') !== (document.replacementText !== undefined) ||
      (state.protectedPaths.includes(document.path) && !['protected', 'retain'].includes(document.disposition))) context.addIssue({ code: 'custom', message: 'Protection exact revision/classification conflict' })
  }
})
export type MaintenanceProtection = z.infer<typeof schema>

/** Host-only human classification receipt. Missing policy grants no execution.
 * Known-manual/protected paths are monotonic: this adapter has no unprotect API.
 * Unlisted/unsupported sources are never authorized by a partial checklist. */
export class DocumentMaintenanceProtection {
  private readonly file: string
  constructor(home: string, private readonly projectId: string) {
    this.file = projectStoragePath(home, 'state/learning/document-maintenance-v1/protection.json')
  }
  private journal() {
    let ancestor = dirname(this.file)
    while (!existsSync(ancestor)) ancestor = dirname(ancestor)
    safePath(ancestor)
    if (existsSync(this.file)) safePath(this.file)
    return new Journal<MaintenanceProtection | null>(this.file, value => {
      const state = schema.parse(value)
      if (state.projectId !== this.projectId) throw new Error('Foreign protection policy')
      return state
    })
  }
  status() {
    const state = this.journal().read(null)
    if (state) {
      const bytes = canonical(state), audit = join(dirname(this.file), 'protection-receipts', `${checksum(bytes)}.json`)
      if (readSafe(audit, 64 * 1024 * 1024).content !== bytes) throw new Error('Current protection audit missing or corrupt')
    }
    return structuredClone(state)
  }
  revision() { return checksum(canonical(this.status())) }
  assertUnprotected(path: string) {
    if (this.status()?.protectedPaths.includes(path)) throw new Error('Human-classified known-manual/protected document cannot enter maintenance selection')
  }
  /** Caller is the host adapter AFTER a live ownerOnly human content settlement,
   * never a client-submitted decision reference or historical ask lookup. */
  publish(documents: z.infer<typeof protectionClassification>[], originals: MaintenanceProtection['originals'], inventoryRevision: string,
    contentPlanRevision: string, decisionReference: string, expectedRevision: string) {
    const journal = this.journal(), previous = journal.read(null)
    if (checksum(canonical(previous)) !== expectedRevision) throw new Error('Protection policy changed; new content review required')
    const protectedPaths = new Set(previous?.protectedPaths ?? [])
    for (const document of documents) {
      protectionClassification.parse(document)
      if (protectedPaths.has(document.path) && !['protected', 'retain'].includes(document.disposition)) throw new Error('Known-manual/protected classification cannot be removed')
      if (document.disposition === 'protected') protectedPaths.add(document.path)
    }
    const state = schema.parse({ version: 1, projectId: this.projectId, generation: (previous?.generation ?? 0) + 1,
      protectedPaths: [...protectedPaths].sort(), inventoryRevision, contentPlanRevision, classifications: documents, originals,
      decisionReference, previousRevision: previous ? checksum(canonical(previous)) : null,
      coverage: 'supported-single-documents-only-unlisted-unsupported-new-or-changed-protected', provenance: 'unknown-not-attested-by-human-classification' })
    // Immutable audit publication may precede a failed CAS; it grants no authority
    // unless the current journal points to this exact complete receipt.
    const directory = join(dirname(this.file), 'protection-receipts'), bytes = canonical(state)
    mkdirSync(directory, { recursive: true }); safePath(directory)
    const audit = join(directory, `${checksum(bytes)}.json`)
    if (existsSync(audit)) {
      if (readSafe(audit, 64 * 1024 * 1024).content !== bytes) throw new Error('Immutable protection audit conflict')
    } else {
      const fd = openSync(audit, 'wx', 0o600)
      try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    }
    journal.save(state)
    return structuredClone(state)
  }
  assertApproved(contentPlanRevision: string) {
    const state = this.status()
    if (!state || state.contentPlanRevision !== contentPlanRevision) throw new Error('Current human full-list protection classification required before execution')
  }
}
