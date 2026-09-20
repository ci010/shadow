import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { writePrivateFile } from '../config/store.ts'
import type { SkillsManager } from '../skills/loader.ts'
import { parseSkillFile } from '../skills/parse.ts'
import { workspacePath } from '../utils/paths.ts'
import type { KnowledgeDetail } from './contracts.ts'
import { canonicalReference, jsonlReferences, markdownReferenceSpans, type MarkdownReference } from './links.ts'
import { KnowledgeError, KnowledgeService, KNOWLEDGE_LIMITS, readSafe, safePath, validPath } from './service.ts'
import type {
  KnowledgeMaintenanceFinding, KnowledgeMaintenanceReport, KnowledgeMaintenanceStatus, KnowledgeRepairPreview,
} from './maintenance-contracts.ts'

export const KNOWLEDGE_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000
export const KNOWLEDGE_MAINTENANCE_REPORT_BYTES = KNOWLEDGE_LIMITS.totalBytes

const digest = (text: string) => createHash('sha256').update(text).digest('hex')
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/)
const sourceIdSchema = z.string().min(1).max(2048).refine(id =>
  (id.startsWith('builtin:skills/') && validPath(id.slice('builtin:'.length)) && id.split('/').length === 2)
  || (validPath(id) && (id.startsWith('memory/') || /^skills\/[^/]+\/SKILL\.md$/.test(id))))
const findingSchema = z.object({
  id: hashSchema, sourceId: sourceIdSchema, sourceTitle: z.string().max(8192),
  target: z.string().min(1).max(4096), label: z.string().max(8192),
  reason: z.enum(['missing', 'unavailable', 'outside-catalog']), repairable: z.boolean(),
  message: z.string().max(1024),
}).strict()
const documentSchema = z.object({
  version: z.literal(1),
  report: z.object({
    id: z.string().uuid(), scannedAt: z.string().datetime(),
    entriesScanned: z.number().int().min(0).max(KNOWLEDGE_LIMITS.entries),
    findings: z.array(findingSchema).max(KNOWLEDGE_LIMITS.links),
  }).strict(),
  sources: z.array(z.object({ sourceId: sourceIdSchema, revision: hashSchema }).strict()).max(KNOWLEDGE_LIMITS.entries),
  checksum: hashSchema,
}).strict()
type Document = z.infer<typeof documentSchema>
type Reference = { target: string; label: string; start?: number; end?: number; supported?: boolean; destinationSupported?: boolean }

function errno(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' ? error.code : undefined
}

function findingId(sourceId: string, target: string, ref: Reference, index: number): string {
  return digest(JSON.stringify([sourceId, target, ref.label, ref.start ?? index, ref.end ?? -1]))
}

function checkedDocument(value: unknown): Document {
  const parsed = documentSchema.safeParse(value)
  if (!parsed.success) throw new KnowledgeError('invalid_maintenance_report', 'Persisted maintenance report is invalid; it was not discarded', 422)
  const { checksum, ...payload } = parsed.data
  const sources = new Map(payload.sources.map(source => [source.sourceId, source.revision]))
  if (checksum !== digest(JSON.stringify(payload)) || sources.size !== payload.sources.length
    || sources.size !== payload.report.entriesScanned
    || new Set(payload.report.findings.map(finding => finding.id)).size !== payload.report.findings.length
    || payload.report.findings.some(finding => !sources.has(finding.sourceId)
      || (finding.repairable && (finding.reason !== 'missing' || !finding.sourceId.startsWith('memory/'))))) {
    throw new KnowledgeError('invalid_maintenance_report', 'Persisted maintenance report failed integrity checks; it was not discarded', 422)
  }
  return parsed.data
}

function parseDocument(content: string): Document {
  let raw: unknown
  try { raw = JSON.parse(content) }
  catch (error) {
    if (error instanceof SyntaxError) throw new KnowledgeError('invalid_maintenance_report', 'Persisted maintenance report contains invalid JSON', 422)
    throw error
  }
  return checkedDocument(raw)
}

/**
 * Deterministic, project-bound link inspection. The caller owns scheduling; no
 * model calls, page deletion, history rewriting, or background repairs occur.
 */
export class KnowledgeMaintenanceService {
  private readonly workspace: string
  private readonly directory: string
  private readonly file: string
  private readonly knowledge: KnowledgeService
  private document: Document | undefined
  private diskRevision: string | undefined
  private invalidReportRevision: string | undefined
  private initialized = false
  private stopped = false
  private pending: Promise<KnowledgeMaintenanceReport> | undefined
  private controller: AbortController | undefined
  private lastError: string | undefined

  constructor(workspace: string, private readonly skills: SkillsManager) {
    this.workspace = workspacePath(workspace)
    this.directory = workspacePath(this.workspace, '.knowledge-maintenance')
    this.file = workspacePath(this.directory, 'report.json')
    this.knowledge = new KnowledgeService(this.workspace, skills)
  }

  async init(): Promise<void> {
    if (this.stopped) throw new KnowledgeError('maintenance_stopped', 'Knowledge maintenance has stopped', 503)
    if (this.pending) throw new KnowledgeError('maintenance_busy', 'A knowledge scan is running', 409)
    if (this.initialized) return
    try {
      safePath(this.workspace)
      const disk = this.readDisk()
      if (disk) {
        this.document = parseDocument(disk.content)
        this.diskRevision = disk.revision
      }
      this.lastError = undefined
    } catch (error) {
      this.recordError(error)
    } finally { this.initialized = true }
  }

  status(): KnowledgeMaintenanceStatus {
    return {
      intervalMs: KNOWLEDGE_MAINTENANCE_INTERVAL_MS,
      scanning: !!this.pending,
      report: this.document ? structuredClone(this.document.report) : null,
      ...(this.lastError ? { lastError: this.lastError } : {}),
    }
  }

  scan(signal?: AbortSignal): Promise<KnowledgeMaintenanceReport> {
    this.assertIdle()
    this.controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    const task = this.runScan(combined).catch(error => {
      if (!combined.aborted) this.recordError(error)
      throw error
    }).finally(() => {
      this.pending = undefined
      this.controller = undefined
    })
    this.pending = task
    return task
  }

  preview(reportId: unknown, sourceId: unknown): KnowledgeRepairPreview {
    this.assertIdle()
    const request = z.object({ reportId: z.string().uuid(), sourceId: sourceIdSchema }).safeParse({ reportId, sourceId })
    if (!request.success) throw new KnowledgeError('invalid_maintenance_request', 'A report ID and canonical source ID are required')
    this.assertDiskCurrent()
    const document = this.document
    if (!document || document.report.id !== request.data.reportId) {
      throw new KnowledgeError('maintenance_changed', 'This report is no longer current; scan or refresh before repairing', 409)
    }
    const expected = document.sources.find(source => source.sourceId === sourceId)
    const findings = document.report.findings.filter(finding => finding.sourceId === sourceId && finding.repairable)
    if (!expected || !findings.length) throw new KnowledgeError('no_knowledge_repairs', 'This source has no confirmed repairable Wiki links', 409)
    let detail: KnowledgeDetail
    try { detail = this.knowledge.detail(request.data.sourceId) }
    catch (error) {
      if (error instanceof KnowledgeError && (error.status === 404 || error.status === 403)) {
        throw new KnowledgeError('maintenance_changed', 'The source disappeared or became unavailable; scan again', 409)
      }
      throw error
    }
    if (detail.entry.source !== 'project' || detail.entry.kind !== 'wiki' || detail.entry.revision !== expected.revision) {
      throw new KnowledgeError('maintenance_changed', 'The source changed; scan again before repairing', 409)
    }
    if (digest(detail.content) !== detail.entry.revision) {
      throw new KnowledgeError('invalid_knowledge_content', 'This source is not valid UTF-8; automatic link repair is unavailable', 422)
    }
    const skillIds = this.skillIds()
    const repairIds = new Set(findings.map(finding => finding.id))
    const edits: MarkdownReference[] = []
    const found: string[] = []
    markdownReferenceSpans(detail.content).forEach((ref, index) => {
      const target = ref.destinationSupported ? canonicalReference(ref.target, detail.entry.id, this.workspace, skillIds) : undefined
      if (!target) return
      const id = findingId(detail.entry.id, target, ref, index)
      if (!repairIds.has(id)) return
      if (!ref.supported || this.probe(target) !== 'missing') {
        throw new KnowledgeError('maintenance_changed', 'A repair target is no longer confirmed missing; scan again', 409)
      }
      edits.push(ref)
      found.push(id)
    })
    if (found.length !== findings.length) {
      throw new KnowledgeError('maintenance_changed', 'Link resolution changed; scan again before repairing', 409)
    }
    let after = detail.content
    for (const edit of edits.reverse()) after = after.slice(0, edit.start) + edit.label + after.slice(edit.end)
    return {
      reportId: request.data.reportId, sourceId: request.data.sourceId, revision: expected.revision,
      before: detail.content, after, findingIds: found,
    }
  }

  apply(reportId: unknown, sourceId: unknown, revision: unknown): { updated: string } {
    if (!hashSchema.safeParse(revision).success) throw new KnowledgeError('invalid_knowledge_revision', 'A SHA-256 preview revision is required')
    const preview = this.preview(reportId, sourceId)
    if (preview.revision !== revision) throw new KnowledgeError('maintenance_changed', 'The preview revision is stale', 409)
    const file = workspacePath(this.workspace, ...preview.sourceId.split('/'))
    // These checks and the atomic replacement are synchronous: another service
    // operation cannot interleave between confirmation and the write.
    if (readSafe(file).revision !== preview.revision) throw new KnowledgeError('maintenance_changed', 'The source changed before repair', 409)
    safePath(file)
    writePrivateFile(file, preview.after)
    return { updated: preview.sourceId }
  }

  async stop(): Promise<void> {
    this.stopped = true
    const pending = this.pending
    this.controller?.abort()
    if (pending) {
      try { await pending }
      catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) throw error
      }
    }
  }

  private assertIdle(): void {
    if (this.stopped) throw new KnowledgeError('maintenance_stopped', 'Knowledge maintenance has stopped', 503)
    if (!this.initialized) throw new KnowledgeError('maintenance_uninitialized', 'Knowledge maintenance is not initialized', 503)
    if (this.pending) throw new KnowledgeError('maintenance_busy', 'A knowledge scan is running; try again when it completes', 409)
  }

  private skillIds(): Map<string, string> {
    return new Map(this.skills.availableSkillSources(true).map(({ skill, source }) => [
      skill.meta.name,
      source === 'builtin' ? `builtin:skills/${skill.meta.name}`
        : relative(this.workspace, resolve(skill.dirPath, 'SKILL.md')).split(sep).join('/'),
    ]))
  }

  private probe(target: string): KnowledgeMaintenanceFinding['reason'] {
    if (!validPath(target)) return 'unavailable'
    try { safePath(this.workspace) }
    catch (error) {
      if (error instanceof KnowledgeError || errno(error)) return 'unavailable'
      throw error
    }
    try {
      const info = safePath(workspacePath(this.workspace, ...target.split('/')))
      return info.isFile() || info.isDirectory() ? 'outside-catalog' : 'unavailable'
    } catch (error) {
      if (errno(error) === 'ENOENT') return 'missing'
      if (error instanceof KnowledgeError || errno(error)) return 'unavailable'
      throw error
    }
  }

  private assertDiskCurrent(): void {
    const current = this.readDisk()?.revision
    if (current !== this.diskRevision) throw new KnowledgeError('maintenance_changed', 'The persisted report changed; scan again before applying repairs', 409)
  }

  private readDisk(): ReturnType<typeof readSafe> | undefined {
    try { return readSafe(this.file, KNOWLEDGE_MAINTENANCE_REPORT_BYTES) }
    catch (error) {
      if (errno(error) !== 'ENOENT') throw error
      return undefined
    }
  }

  private recordError(error: unknown): void {
    this.lastError = error instanceof Error ? error.message : 'Knowledge maintenance failed'
    console.warn('[knowledge-maintenance]', this.lastError)
  }

  private refreshScanStorage(): void {
    safePath(this.workspace)
    const disk = this.readDisk()
    this.diskRevision = disk?.revision
    this.invalidReportRevision = undefined
    this.document = undefined
    if (!disk) return
    try { this.document = parseDocument(disk.content) }
    catch (error) {
      if (!(error instanceof KnowledgeError && error.code === 'invalid_maintenance_report')) throw error
      this.invalidReportRevision = disk.revision
      this.recordError(error)
    }
  }

  private preserveInvalidReport(): void {
    if (!this.invalidReportRevision) return
    const original = readSafe(this.file, KNOWLEDGE_MAINTENANCE_REPORT_BYTES)
    if (original.revision !== this.invalidReportRevision) {
      throw new KnowledgeError('maintenance_changed', 'The invalid report changed during recovery; scan again', 409)
    }
    const archive = workspacePath(this.directory, `report.invalid-${original.revision}.json`)
    let existing: ReturnType<typeof readSafe> | undefined
    try { existing = readSafe(archive, KNOWLEDGE_MAINTENANCE_REPORT_BYTES) }
    catch (error) {
      if (errno(error) !== 'ENOENT') throw error
    }
    if (existing && existing.revision !== original.revision) {
      throw new KnowledgeError('maintenance_changed', 'An existing corruption-evidence file changed; recovery will not overwrite it', 409)
    }
    if (!existing) {
      safePath(this.directory)
      const descriptor = openSync(archive, 'wx', 0o600)
      try {
        writeFileSync(descriptor, original.bytes)
        fsyncSync(descriptor)
      } finally { closeSync(descriptor) }
      if (readSafe(archive, KNOWLEDGE_MAINTENANCE_REPORT_BYTES).revision !== original.revision) {
        throw new KnowledgeError('maintenance_changed', 'Corruption evidence could not be verified; recovery stopped', 409)
      }
    }
    this.assertDiskCurrent()
    this.invalidReportRevision = undefined
  }

  private async runScan(signal: AbortSignal): Promise<KnowledgeMaintenanceReport> {
    // Yield before the bounded synchronous snapshot so stop/overlap admission is
    // observable, then yield regularly while inspecting targets.
    await setImmediate(undefined, { signal })
    this.refreshScanStorage()
    const details = this.knowledge.snapshot()
    const entries = new Set(details.map(detail => detail.entry.id))
    const skillIds = new Map(details.filter(detail => detail.entry.kind === 'skill')
      .map(detail => [detail.entry.title, detail.entry.id]))
    const sources = details.map(detail => ({ sourceId: detail.entry.id, revision: detail.entry.revision }))
    const findings: KnowledgeMaintenanceFinding[] = []
    let reportBytes = Buffer.byteLength(JSON.stringify(sources)) + 256
    let referencesScanned = 0
    for (const detail of details) {
      signal.throwIfAborted()
      const wiki = detail.entry.kind === 'wiki' && detail.entry.source === 'project'
      const validUtf8 = !wiki || digest(detail.content) === detail.entry.revision
      let refs: Reference[]
      try {
        refs = detail.entry.path.endsWith('.jsonl') ? jsonlReferences(detail.content) : markdownReferenceSpans(detail.content)
      } catch (error) {
        if (error instanceof SyntaxError) throw new KnowledgeError('invalid_knowledge_content', `Invalid JSONL in ${detail.entry.id}; maintenance report was not truncated`, 422)
        throw error
      }
      if (detail.entry.kind === 'skill') {
        const related = parseSkillFile(detail.content, detail.entry.title).learnedMeta?.related
        for (const name of related?.split(',').map(value => value.trim()).filter(Boolean) ?? []) {
          refs.push({ target: `v:skills/${name}`, label: 'related' })
        }
      }
      for (let index = 0; index < refs.length; index++) {
        if (++referencesScanned > KNOWLEDGE_LIMITS.links) throw new KnowledgeError('knowledge_limit', 'Maintenance scan exceeds 100,000 references', 413)
        if (referencesScanned % 128 === 0) await setImmediate(undefined, { signal })
        const ref = refs[index]
        if (!ref.target || /^(?:#|https?:|mailto:|tel:|ftp:|data:|\/\/)/i.test(ref.target)) continue
        const canonical = ref.destinationSupported === false ? undefined
          : canonicalReference(ref.target, detail.entry.id, this.workspace, skillIds)
        if (canonical && entries.has(canonical)) continue
        const target = canonical ?? ref.target
        const reason = canonical ? this.probe(canonical) : 'unavailable'
        const repairable = reason === 'missing' && wiki && validUtf8 && ref.supported === true
        const message = reason === 'outside-catalog'
          ? 'The target exists inside this Project but is not a catalog entry. No repair is needed.'
          : reason === 'unavailable'
          ? 'The target is unsafe, inaccessible, or outside the Project inspection scope. Missing status is not confirmed.'
          : !wiki
          ? 'The target is missing, but this source is protected. Memory history and skills are never rewritten.'
          : !validUtf8
          ? 'The target is missing, but the source is not valid UTF-8. Safe text replacement is unavailable.'
          : !ref.supported
          ? 'The target is missing, but this Markdown label is unsupported for safe plain-text replacement.'
          : 'The local target is confirmed missing. Confirm a preview to replace this Wiki link with its label.'
        const finding = {
          id: findingId(detail.entry.id, target, ref, index),
          sourceId: detail.entry.id, sourceTitle: detail.entry.title, target, label: ref.label,
          reason, repairable, message,
        }
        if (!findingSchema.safeParse(finding).success) throw new KnowledgeError('knowledge_limit', 'A maintenance finding exceeds the supported text limits', 413)
        reportBytes += Buffer.byteLength(JSON.stringify(finding)) + 1
        if (reportBytes > KNOWLEDGE_MAINTENANCE_REPORT_BYTES) throw new KnowledgeError('knowledge_limit', 'Maintenance report exceeds 32 MiB', 413)
        findings.push(finding)
      }
      await setImmediate(undefined, { signal })
    }
    signal.throwIfAborted()
    const payload = {
      version: 1 as const,
      report: {
        id: randomUUID(), scannedAt: new Date().toISOString(), entriesScanned: details.length, findings,
      },
      sources,
    }
    const next = checkedDocument({ ...payload, checksum: digest(JSON.stringify(payload)) })
    const content = JSON.stringify(next) + '\n'
    if (Buffer.byteLength(content) > KNOWLEDGE_MAINTENANCE_REPORT_BYTES) throw new KnowledgeError('knowledge_limit', 'Maintenance report exceeds 32 MiB', 413)
    this.assertDiskCurrent()
    safePath(this.workspace)
    try { safePath(this.directory) }
    catch (error) {
      if (errno(error) !== 'ENOENT') throw error
      mkdirSync(this.directory, { mode: 0o700 })
    }
    safePath(this.directory)
    this.assertDiskCurrent()
    this.preserveInvalidReport()
    writePrivateFile(this.file, content)
    this.document = next
    this.diskRevision = digest(content)
    this.lastError = undefined
    return structuredClone(next.report)
  }
}
