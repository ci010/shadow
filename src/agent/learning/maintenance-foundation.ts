import { constants, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { Journal } from '../../watermarks/journal.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { archivePathSchema, candidateSchema, canonical, captureCutoffs, checksum, manifestRevision, manifestSchema,
  revisionSchema, verifyCutoffs, type ArchiveCandidate, type MaintenanceHistory, type MaintenanceManifest } from './maintenance-contracts.ts'

const member = z.string().min(1).max(512).refine(path => !path.startsWith('/') && !/[\\:\x00-\x1f]/u.test(path)
  && path.split('/').every(part => part !== '' && part !== '.' && part !== '..' && !part.startsWith('.')), 'Unsafe snapshot member')
const base64 = z.string().max(48 * 1024 * 1024).refine(value => Buffer.from(value, 'base64').toString('base64') === value, 'Expected canonical base64')
export const snapshotSchema = z.object({
  version: z.literal(1), files: z.record(member, base64), directories: z.array(member).max(1000),
}).strict().superRefine((value, context) => {
  const names = [...Object.keys(value.files), ...value.directories]
  if (!Object.keys(value.files).length || names.length > 1000 || new Set(names.map(name => name.toUpperCase())).size !== names.length
    || Object.values(value.files).reduce((size, data) => size + Buffer.byteLength(data, 'base64'), 0) > 32 * 1024 * 1024) {
    context.addIssue({ code: 'custom', message: 'Invalid, colliding or oversized snapshot package' })
  }
  for (const name of names) {
    const parts = name.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (!value.directories.includes(parts.slice(0, index).join('/'))) context.addIssue({ code: 'custom', message: 'Missing package directory' })
    }
  }
})
export type MaintenanceSnapshot = z.infer<typeof snapshotSchema>
export function snapshotRevision(raw: MaintenanceSnapshot): string {
  const value = snapshotSchema.parse(raw)
  return checksum(canonical({ ...value, directories: [...value.directories].sort() }))
}
function snapshotFor(candidate: ArchiveCandidate, raw: MaintenanceSnapshot): MaintenanceSnapshot {
  const value = snapshotSchema.parse(raw)
  if (candidate.path.startsWith('memory/')) {
    if (canonical(Object.keys(value.files)) !== '["page.md"]' || value.directories.length) throw new Error('Wiki snapshot must contain exactly page.md')
  } else if (!Object.hasOwn(value.files, 'SKILL.md')) throw new Error('Skill snapshot must contain its complete package')
  if (snapshotRevision(value) !== candidate.snapshotRevision) throw new Error('Candidate snapshot revision conflict')
  return value
}

const stateSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1), operationId: z.string().uuid(),
  manifestRevision: revisionSchema, manifest: manifestSchema,
  generation: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  phase: z.enum(['preparing', 'prepared', 'committing', 'committed', 'blocked']),
  snapshots: z.record(archivePathSchema, revisionSchema), error: z.string().max(2000).optional(),
}).strict().superRefine((value, context) => {
  if (value.projectId !== value.manifest.projectId || value.operationId !== value.manifest.operationId
    || value.manifestRevision !== manifestRevision(value.manifest)) context.addIssue({ code: 'custom', message: 'Maintenance state identity/checksum conflict' })
  const candidates = new Map(value.manifest.candidates.map(candidate => [candidate.path, candidate.snapshotRevision]))
  if (Object.entries(value.snapshots).some(([path, revision]) => candidates.get(path) !== revision)
    || (['prepared', 'committing', 'committed'].includes(value.phase) && Object.keys(value.snapshots).length !== candidates.size)) {
    context.addIssue({ code: 'custom', message: 'Maintenance snapshot receipt conflict' })
  }
})
export type MaintenanceFoundationState = z.infer<typeof stateSchema>
export interface MaintenanceSources {
  history: MaintenanceHistory
  /** Host-owned attestation binding native sourceRevision to the real automatic receipt
   * and the complete package to independent snapshotRevision. Never rehash/mint an
   * artifact receipt to match an envelope. Must reject symlinks/incomplete packages,
   * unproven manual resources, and caller-supplied provenance. */
  candidates(): Promise<ArchiveCandidate[]>
  snapshot(candidate: ArchiveCandidate): Promise<MaintenanceSnapshot>
}

/** INTERNAL FOUNDATION ONLY. Not wired to routes, learning admission or live views.
 * prepare writes receipts/snapshots only; it cannot retire content or advance an epoch. */
export class LearningMaintenanceFoundation {
  private readonly home: string
  private readonly root: string
  private readonly file: string
  private readonly journal: Journal<MaintenanceFoundationState>
  private poisoned = false
  private preparing = false
  constructor(projectHome: string, readonly projectId: string, private readonly sources: MaintenanceSources) {
    const home = this.home = realpathSync(projectHome)
    this.root = projectStoragePath(home, '.learning', 'maintenance-foundation-v1')
    this.file = join(this.root, 'state.json')
    this.assertAncestors(home, this.root, false)
    this.assertRegular(this.file)
    this.journal = new Journal(this.file, value => this.parseState(value))
    // Reject foreign/corrupt state before any supported operation.
    this.status()
  }
  private parseState(raw: unknown): MaintenanceFoundationState {
    const state = stateSchema.parse(raw)
    if (state.projectId !== this.projectId) throw new Error('Foreign maintenance state')
    return state
  }
  private assertRegular(file: string): void {
    try { if (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()) throw new Error('Unsafe maintenance file') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  private assertAncestors(home: string, target: string, create: boolean): void {
    const path = relative(home, target)
    if (path === '..' || path.startsWith(`..${sep}`) || resolve(home, path) !== target) throw new Error('Unsafe maintenance root')
    let current = home
    for (const component of path.split(sep).filter(Boolean)) {
      current = join(current, component)
      try {
        const info = lstatSync(current)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe maintenance directory')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        if (!create) continue
        try { mkdirSync(current) } catch (creation) { if ((creation as NodeJS.ErrnoException).code !== 'EEXIST') throw creation }
        const info = lstatSync(current)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe maintenance directory')
      }
    }
  }
  status(): { activation: 'unsupported'; state: MaintenanceFoundationState | null } {
    this.assertAncestors(this.home, this.root, false)
    this.assertRegular(this.file)
    const state = existsSync(this.file) ? this.parseState(JSON.parse(readFileSync(this.file, 'utf8'))) : null
    return { activation: 'unsupported', state }
  }
  async preview(input: { operationId: string; createdAt: string; fromEpoch: number }): Promise<{ manifest: MaintenanceManifest; revision: string }> {
    const request = z.object({ operationId: z.string().uuid(), createdAt: z.string().datetime({ offset: true }),
      fromEpoch: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 2) }).strict().parse(input)
    const candidates = (await this.sources.candidates()).map(value => candidateSchema.parse(value)).sort((a, b) => a.path.localeCompare(b.path))
    const history = await captureCutoffs(this.projectId, this.sources.history)
    const manifest = manifestSchema.parse({ version: 1, projectId: this.projectId, ...request, toEpoch: request.fromEpoch + 1,
      candidates, ...history })
    return { manifest, revision: manifestRevision(manifest) }
  }
  private save(state: MaintenanceFoundationState): void {
    if (this.poisoned) throw new Error('Maintenance instance requires reload after failure')
    try {
      this.assertAncestors(this.home, join(this.root, 'snapshots'), true)
      this.assertRegular(this.file)
      const next = this.parseState({ ...state, generation: state.generation + 1 })
      this.journal.save(next)
      state.generation = next.generation
    } catch (error) { this.poisoned = true; throw error }
  }
  private writeSnapshot(revision: string, value: MaintenanceSnapshot): void {
    const file = join(this.root, 'snapshots', `${revision}.json`)
    const bytes = canonical({ ...value, directories: [...value.directories].sort() })
    this.assertRegular(file)
    if (existsSync(file)) {
      if (readFileSync(file, 'utf8') !== bytes) throw new Error('Immutable snapshot hash conflict')
      return
    }
    let descriptor: number
    try { descriptor = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o400) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST' && readFileSync(file, 'utf8') === bytes) return
      throw error
    }
    try { writeFileSync(descriptor, bytes); fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }
  /** Explicit historical read; returns detached evidence, never active instructions. */
  archive(path: string): { archived: true; instructionAuthority: false; snapshot: MaintenanceSnapshot } {
    archivePathSchema.parse(path)
    const state = this.status().state
    const revision = state?.snapshots[path]
    if (!revision) throw new Error('No verified snapshot receipt for this path')
    const file = join(this.root, 'snapshots', `${revision}.json`)
    this.assertAncestors(this.home, dirname(file), false)
    this.assertRegular(file)
    const snapshot = snapshotSchema.parse(JSON.parse(readFileSync(file, 'utf8')))
    if (snapshotRevision(snapshot) !== revision) throw new Error('Immutable snapshot hash conflict')
    return { archived: true, instructionAuthority: false, snapshot }
  }
  async prepare(raw: MaintenanceManifest, expectedRevision: string): Promise<MaintenanceFoundationState> {
    if (this.preparing) throw new Error('Maintenance preparation already running in this instance')
    this.preparing = true
    try { return await this.prepareOperation(raw, expectedRevision) }
    finally { this.preparing = false }
  }
  private async prepareOperation(raw: MaintenanceManifest, expectedRevision: string): Promise<MaintenanceFoundationState> {
    if (this.poisoned) throw new Error('Maintenance instance requires reload after failure')
    const manifest = manifestSchema.parse(raw)
    revisionSchema.parse(expectedRevision)
    if (manifest.projectId !== this.projectId || manifestRevision(manifest) !== expectedRevision) throw new Error('Manifest revision/Project conflict')
    const existing = this.status().state
    if (existing && (existing.operationId !== manifest.operationId || existing.manifestRevision !== expectedRevision)) throw new Error('Maintenance operation conflict')
    if (existing?.phase === 'blocked') throw new Error('Maintenance operation blocked; operator review required')
    if (existing && !['preparing', 'prepared'].includes(existing.phase)) throw new Error('Activation is unsupported in foundation')
    if (existing?.phase === 'prepared') {
      try {
        for (const candidate of existing.manifest.candidates) this.archive(candidate.path)
      } catch (error) {
        existing.phase = 'blocked'; existing.error = 'Previously verified snapshot is unavailable or corrupt; operator review required.'
        this.save(existing)
        throw error
      }
      return structuredClone(existing)
    }
    const state: MaintenanceFoundationState = existing ?? { version: 1, projectId: this.projectId, operationId: manifest.operationId,
      manifestRevision: expectedRevision, manifest, generation: 0, phase: 'preparing', snapshots: {} }
    // Reservation is durable before invoking any asynchronous adapter. Another instance's CAS cannot overwrite it.
    this.assertAncestors(this.home, this.root, true)
    this.save(state)
    try {
      const current = (await this.sources.candidates()).map(value => candidateSchema.parse(value))
      for (const candidate of manifest.candidates) {
        const matches = current.filter(value => value.path === candidate.path)
        if (matches.length !== 1 || canonical(matches[0]) !== canonical(candidate)) throw new Error('Candidate provenance/revision conflict')
      }
      const captured = await captureCutoffs(this.projectId, this.sources.history)
      if (captured.inventoryRevision !== manifest.inventoryRevision || canonical(captured.cutoffs) !== canonical(manifest.cutoffs)) {
        throw new Error('History cutoff inventory conflict; preview again')
      }
      await verifyCutoffs(manifest.cutoffs, this.sources.history)
      for (const candidate of manifest.candidates) {
        const snapshot = snapshotFor(candidate, await this.sources.snapshot(candidate))
        this.writeSnapshot(candidate.snapshotRevision, snapshot)
        state.snapshots[candidate.path] = candidate.snapshotRevision
        this.save(state)
      }
      state.phase = 'prepared'
      this.save(state)
      return structuredClone(state)
    } catch (error) {
      if (!this.poisoned) {
        state.phase = 'blocked'; state.error = 'Preparation failed; inspect adapter evidence and immutable snapshots before any recovery.'
        this.save(state)
      }
      throw error
    }
  }
  apply(): never { throw new Error('Learning maintenance activation is unsupported: no epoch or active view is changed') }
}
