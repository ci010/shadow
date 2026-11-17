import { existsSync, readdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { readSafe, safePath } from '../../knowledge/service.ts'
import { SkillEditStore } from '../../skills/edit-store.ts'
import type { SkillsManager } from '../../skills/loader.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { LearningLedger } from './ledger.ts'
import { checksum, archivePathSchema, type ArchiveCandidate, type MaintenanceHistory } from './maintenance-contracts.ts'
import { snapshotRevision, type MaintenanceSnapshot, type MaintenanceSources } from './maintenance-foundation.ts'

export interface ProtectedMaintenanceSource {
  path: string; sourceRevision: string; snapshotRevision: string
  reason: 'automatic-receipt-is-not-exclusive-ownership'
}

/** Read-only production assessment. Existing LearningLedger artifacts prove a
 * final automatic write, NOT exclusive ownership of all retained content. Until
 * a supported creation/preimage lineage attests that stronger fact, matching
 * receipts remain protected and cannot be signed as manual:false candidates.
 * No caller-supplied provenance or filename/frontmatter heuristic can lift this. */
export class ProjectMaintenanceSources implements MaintenanceSources {
  constructor(private readonly home: string, private readonly projectId: string,
    private readonly skills: SkillsManager, readonly history: MaintenanceHistory,
    private readonly protectedDocumentPaths: ReadonlySet<string> = new Set(),
    private readonly assertHumanProtection: (path: string) => void = () => {}) {}

  /** Observation only, never automatic ownership or permission to retire.
   * Decisions are conservatively protected in this preparatory interface.
   * Additional known-manual/protected paths are host policy, not HTTP input. */
  observeDocument(path: string): { sourceRevision: string; snapshot: MaintenanceSnapshot } {
    archivePathSchema.parse(path)
    this.assertHumanProtection(path)
    if (path.startsWith('memory/decisions/') || this.protectedDocumentPaths.has(path)) {
      throw new Error('Host-protected document cannot enter maintenance selection')
    }
    if (path.startsWith('skills/')) {
      const name = path.split('/')[1]!
      if (this.skills.availableSkillSources(true).some(item => item.skill.meta.name === name && (item.source === 'builtin' || item.shadowsBuiltin))) throw new Error('Builtin skills and their overrides are protected')
    }
    return this.read(path)
  }

  /** Bounded full inventory of this narrow representable document domain only.
   * Never scans identities, decisions, conventions, sessions, events, credentials
   * or resource bytes. Unsupported/unreadable/hard-protected paths are listed,
   * not silently treated as eligible. Unknown provenance stays unknown. */
  documentInventory() {
    const paths: string[] = []
    for (const root of ['memory/topics', 'memory/concepts', 'memory/tools', 'skills']) {
      const directory = projectStoragePath(this.home, root)
      if (!existsSync(directory)) continue
      safePath(directory)
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        const path = root === 'skills' ? `skills/${item.name}/SKILL.md` : `${root}/${item.name}`
        if (archivePathSchema.safeParse(path).success) paths.push(path)
        if (paths.length > 1000) throw new Error('Maintenance classification inventory exceeds 1000; no partial inventory approval')
      }
    }
    const eligible: { path: string; sourceRevision: string; snapshotRevision: string; sourceTextDigest: string }[] = []
    const unsupported: { path: string; disposition: 'protected'; reason: string }[] = []
    for (const path of paths.sort()) {
      try {
        const observed = this.observeDocument(path), member = path.startsWith('memory/') ? 'page.md' : 'SKILL.md'
        eligible.push({ path, sourceRevision: observed.sourceRevision, snapshotRevision: snapshotRevision(observed.snapshot),
          sourceTextDigest: checksum(Buffer.from(observed.snapshot.files[member]!, 'base64')) })
      } catch {
        unsupported.push({ path, disposition: 'protected', reason: 'hard-protected-or-unsupported-or-unreadable-no-mutation-permission' })
      }
    }
    return { coverage: 'supported-single-documents-only' as const, eligible, unsupported,
      outsideCoverage: 'identities-decisions-conventions-builtin-original-evidence-and-all-unlisted-protected' as const }
  }

  private read(path: string): { sourceRevision: string; snapshot: MaintenanceSnapshot } {
    archivePathSchema.parse(path)
    const file = projectStoragePath(this.home, path)
    if (path.startsWith('memory/')) {
      if (safePath(file).nlink !== 1) throw new Error('Hard-linked Wiki sources are protected')
      const page = readSafe(file)
      return { sourceRevision: page.revision, snapshot: { version: 1, directories: [], files: { 'page.md': page.bytes.toString('base64') } } }
    }
    safePath(dirname(file))
    const members = readdirSync(dirname(file))
    if (members.length !== 1 || members[0] !== 'SKILL.md') throw new Error('Unproven skill package members are protected')
    const source = new SkillEditStore(this.home, this.skills).readMaintenanceSnapshot(path.split('/')[1]!)
    if (source.source !== 'project' || !source.revision || Object.keys(source.files).length !== 1 || !source.files['SKILL.md']) {
      throw new Error('Only single-member Project skills can be assessed')
    }
    return { sourceRevision: source.revision, snapshot: { version: 1, directories: [], files: { 'SKILL.md': source.files['SKILL.md'].toString('base64') } } }
  }

  async protectedSources(): Promise<ProtectedMaintenanceSource[]> {
    const receipts = new LearningLedger(this.home, this.projectId).maintenanceArtifacts()
    const found = new Map<string, ProtectedMaintenanceSource>()
    for (const { artifact } of receipts) {
      if (!archivePathSchema.safeParse(artifact.path).success || artifact.kind === 'soul'
        || (artifact.path.startsWith('memory/') ? artifact.kind !== 'memory' : artifact.kind !== 'skill')) continue
      try {
        const source = this.read(artifact.path)
        if (source.sourceRevision !== artifact.revision) continue
        found.set(artifact.path, { path: artifact.path, sourceRevision: source.sourceRevision,
          snapshotRevision: snapshotRevision(source.snapshot), reason: 'automatic-receipt-is-not-exclusive-ownership' })
      } catch (error) {
        // Missing/unsafe/unsupported/changed content remains protected as well,
        // but is not presented as an exactly verified current receipt.
        if (!(error instanceof Error)) throw error
      }
    }
    return [...found.values()].sort((a, b) => a.path.localeCompare(b.path))
  }

  async candidates(): Promise<ArchiveCandidate[]> {
    // Validate the Project ledger even when no eligible exclusive-ownership
    // receipts exist; corruption/foreign state must not look like a clean scan.
    new LearningLedger(this.home, this.projectId).maintenanceArtifacts()
    return []
  }

  async snapshot(_candidate: ArchiveCandidate): Promise<MaintenanceSnapshot> {
    throw new Error('No exclusive automatic ownership proof: source remains protected')
  }
}
