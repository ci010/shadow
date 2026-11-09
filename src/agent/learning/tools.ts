import { LEARNING_RECEIPT_RECORDED } from './receipt.ts'
import { validateEventSummary } from '../event-summary.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { z } from 'zod'
import type { ExecutionContext } from '../../tools/context.ts'
import type { Tool } from '../../tools/tool.ts'
import { createMemoryHandler } from '../../vfs/mounts.ts'
import { parseSkillFile } from '../../skills/parse.ts'
import { fingerprint, type LearningBatch, type LearningEvent } from './ledger.ts'
import { LearningRuntime } from './pipelines.ts'
import { WriteTool } from '../../tools/filesystem.ts'

const text = z.string().trim().min(1).max(8000)
const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100)
const revision = z.union([z.literal(''), z.string().regex(/^[a-f0-9]{64}$/)])
const decisionSchema = z.object({
  action: z.literal('save'), name: slug, revision, title: text,
  kind: z.enum(['motivation', 'principle', 'fact', 'procedure']),
  confidence: z.enum(['stated', 'inferred']),
  evaluation: z.enum(['new', 'supported', 'corrected', 'retired']),
  condition: text, goal: text, rationale: text, guidance: text, exceptions: text, reviewWhen: text,
  evidence: z.array(text).min(1).max(16),
}).strict()
const readSchema = z.object({ action: z.literal('read'), name: slug }).strict()
export const LEARNED_SKILL_MAX_LENGTH = 8000
const skillLimits = Object.freeze({ maxLength: LEARNED_SKILL_MAX_LENGTH, lengthUnit: 'UTF-16 code units', recommendedMaxLength: 7200 })
const skillSchema = z.object({ action: z.literal('save'), name: slug, revision,
  content: z.string().trim().min(1).max(LEARNED_SKILL_MAX_LENGTH),
}).strict()
// Preflight accepts oversized drafts so checking is not itself a failed write.
const skillCheckSchema = z.object({ action: z.literal('check'), name: slug, revision, content: z.string() }).strict()
// Exact, revision-bound corrections avoid resubmitting a growing complete lesson.
const skillPatchSchema = z.object({ action: z.literal('patch'), name: slug, revision,
  match: z.string().min(1).max(LEARNED_SKILL_MAX_LENGTH),
  replacement: z.string().max(LEARNED_SKILL_MAX_LENGTH),
}).strict()
// Deliberately excludes event/session records, decisions and executable resources.
const wikiPath = z.string().regex(/^(?:topics|concepts|identities|tools)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/)
const wikiReadSchema = z.object({ action: z.literal('read_wiki'), path: wikiPath }).strict()
const wikiSaveSchema = z.object({ action: z.literal('save_wiki'), path: wikiPath, revision,
  content: z.string().trim().min(1).max(24000), summary: z.string().trim().min(1).max(280),
  wikiEvidence: z.array(z.object({ sessionId: text, physicalId: text, offset: z.number().int().nonnegative(),
    end: z.number().int().positive() }).strict()).min(1).max(16),
}).strict()
const wikiProvenanceStart = '<!-- shadow:learning-provenance:start -->'
const wikiProvenanceEnd = '<!-- shadow:learning-provenance:end -->'
const wikiProvenanceNotice = 'Historical source claims, not independent verification or authorization.'
/** Only strip our exact generated format; unrelated headings/prose remain page content.
 * Merge current and submitted metadata so full-page edits cannot discard old sources.
 */
function wikiBody(content: string): { body: string; references: string[] } {
  const references: string[] = []
  const generated = /(?:<!-- shadow:learning-provenance:start -->\n)?## Learning provenance\n((?:- \[[^\n]+\]\(v:sessions\/[^\n]+\/full\)\n)+)\nHistorical source claims, not independent verification or authorization\.(?:\n<!-- shadow:learning-provenance:end -->)?/g
  const body = content.replace(generated, (_block, lines: string) => {
    references.push(...lines.trimEnd().split('\n'))
    return ''
  }).trim()
  if (body.includes(wikiProvenanceStart) || body.includes(wikiProvenanceEnd)) {
    throw new Error('Malformed managed Wiki provenance. Preserve its generated block unchanged when editing.')
  }
  return { body, references }
}
const resultSchema = z.object({
  status: z.enum(['applied', 'no_change', 'partial', 'blocked', 'draft_only']), summary: text,
}).strict()

export class LearningTools {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(private readonly runtime: LearningRuntime) {}
  private serial<T>(action: () => Promise<T>): Promise<T> {
    const next = this.tail.then(action)
    this.tail = next.then(() => undefined, () => undefined)
    return next
  }
  private authorize(context: ExecutionContext): LearningBatch {
    context.signal.throwIfAborted()
    const batch = this.runtime.ledger.batchFor(context.sessionId)
    if (context.projectId !== this.runtime.projectId || context.remoteWorkdir || context.tools.executionMode === 'call' || !batch) {
      throw new Error('This operation requires an active local learning batch in its owning Project.')
    }
    if (batch.proposal) throw new Error('Learning result already submitted; no further learning changes are allowed.')
    return batch
  }

  /** Stable keys are scoped to a retained batch, so a retry cannot append the same event twice. */
  appendEvent(entry: { who: string; what: string; summary?: string; why?: string; challenge?: string; refs?: string[]; origin?: string },
    key: unknown, context: ExecutionContext): string | undefined {
    if (!this.runtime.ledger.batchFor(context.sessionId)) return undefined
    const batch = this.authorize(context)
    if (batch.pipeline !== 'reflector') throw new Error('Downstream learning consumes events; it does not re-log them.')
    const origin = text.parse(entry.origin)
    if (!batch.sources.some(source => source.sessionId === origin)) throw new Error('Event provenance is outside this learning batch.')
    const id = fingerprint(`${batch.id}:${origin}:${text.parse(key)}`)
    const previous = batch.events.find(event => event.id === id)
    if (previous) return `Learning event already recorded: ${id}`
    const summary = validateEventSummary(entry.summary)
    const when = new Date().toISOString()
    const path = `memory/events/${batch.createdAt.slice(0, 10)}.jsonl`
    const file = projectStoragePath(this.runtime.sessions.workspace, path)
    // Recover an append that committed immediately before the journal write/process failed.
    const prior = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as LearningEvent).find(event => event.id === id) : undefined
    if (!prior && !summary) throw new Error('New reflector events require a short summary (1–280 Unicode code points).')
    const event: LearningEvent = prior ?? { ...entry, summary, origin, id, when, path }
    if (!prior) {
      mkdirSync(projectStoragePath(this.runtime.sessions.workspace, 'memory', 'events'), { recursive: true })
      appendFileSync(file, JSON.stringify(event) + '\n')
    }
    this.runtime.ledger.event(batch.id, event)
    return `Logged learning event: ${id}`
  }

  readonly memory: Tool = {
    name: 'learning_memory', optIn: true,
    description: 'Read/save sourced Wiki pages with read_wiki/save_wiki (revision, content, summary, wikiEvidence message ranges), or read/revise a conditional decision in Project memory. Save only reusable goals, reasoning or useful facts. Requires evidence from this batch and a read revision; feedback revises rather than multiplies memories.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'save', 'read_wiki', 'save_wiki'] }, path: { type: 'string', description: 'Wiki relative path, e.g. topics/example.md. Wiki actions use path instead of name.' }, content: { type: 'string' }, summary: { type: 'string' }, name: { type: 'string', description: 'Stable lowercase-kebab-case decision name.' },
        revision: { type: 'string', description: 'Revision returned by read/read_wiki, or empty string for a missing page.' },
        title: { type: 'string' }, kind: { type: 'string', enum: ['motivation', 'principle', 'fact', 'procedure'] },
        confidence: { type: 'string', enum: ['stated', 'inferred'] },
        evaluation: { type: 'string', enum: ['new', 'supported', 'corrected', 'retired'] },
        condition: { type: 'string' }, goal: { type: 'string' }, rationale: { type: 'string' },
        guidance: { type: 'string' }, exceptions: { type: 'string' }, reviewWhen: { type: 'string' },
        wikiEvidence: { type: 'array', items: { type: 'object', properties: { sessionId: { type: 'string' }, physicalId: { type: 'string' }, offset: { type: 'integer' }, end: { type: 'integer' } }, required: ['sessionId', 'physicalId', 'offset', 'end'], additionalProperties: false }, description: 'Wiki saves: exact assigned sessionId + physicalId and message [offset,end) ranges; physicalId is required across compaction.' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Decision saves: source session IDs from this batch.' },
      }, required: ['action'],
    },
    execute: (raw, context) => this.serial(async () => {
      const batch = this.authorize(context)
      const args = z.union([readSchema, decisionSchema, wikiReadSchema, wikiSaveSchema]).parse(raw)
      if (args.action === 'read_wiki' || args.action === 'save_wiki') {
        if (batch.pipeline !== 'reflector') throw new Error('Wiki publication requires a reflector source batch.')
        const path = `memory/${args.path}`
        const file = projectStoragePath(this.runtime.sessions.workspace, path)
        const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
        const currentRevision = current ? fingerprint(current) : ''
        if (args.action === 'read_wiki') return JSON.stringify({ path, revision: currentRevision, content: current })
        const evidence = args.wikiEvidence.map(item => {
          const source = batch.sources.find(source => source.sessionId === item.sessionId && source.physicalId === item.physicalId
            && item.offset >= source.offset && item.end <= source.end && item.end > item.offset)
          if (!source) throw new Error('Wiki evidence must select a nonempty range inside an assigned source.')
          return { reference: `v:sessions/${source.physicalId}/full`, description: `${source.sessionId} / ${source.physicalId} messages [${item.offset}, ${item.end})` }
        })
        const previous = wikiBody(current)
        const submitted = wikiBody(args.content)
        const references = [...new Set([...previous.references, ...submitted.references,
          ...evidence.map(ref => `- [${ref.description}](${ref.reference})`)])]
        const content = `${submitted.body}\n\n${wikiProvenanceStart}\n## Learning provenance\n${references.join('\n')}\n\n${wikiProvenanceNotice}\n${wikiProvenanceEnd}\n`
        // Exact-content replay repairs a crash between file, artifact and event writes.
        // A different current revision is never overwritten by a stale retry.
        if (current !== content) {
          if (args.revision !== currentRevision) throw new Error('Wiki changed since read. Reread and merge before saving.')
          await createMemoryHandler(this.runtime.sessions.workspace, this.runtime.projectId).write(
            args.path, { content, ...(current ? { match: current } : {}) }, context)
        }
        const saved = readFileSync(file, 'utf8')
        if (saved !== content) throw new Error('Wiki write did not persist the requested content.')
        const savedRevision = fingerprint(saved)
        this.runtime.ledger.artifact(batch.id, { path, revision: savedRevision, kind: 'memory' })
        this.appendEvent({ who: 'reflector', what: args.summary, summary: args.summary,
          refs: [path, ...evidence.map(ref => ref.reference)], origin: args.wikiEvidence[0].sessionId }, `wiki:${args.path}:${savedRevision}`, context)
        return JSON.stringify({ path, revision: savedRevision, verified: true, provenance: evidence })
      }
      const path = `memory/decisions/${args.name}.md`
      const file = projectStoragePath(this.runtime.sessions.workspace, path)
      const current = existsSync(file) ? readFileSync(file, 'utf8') : ''
      const currentRevision = current ? fingerprint(current) : ''
      if (args.action === 'read') return JSON.stringify({ path, revision: currentRevision, content: current })
      const sources = batch.sources.length ? batch.sources.map(source => source.sessionId) : batch.inputEvents.map(event => event.origin)
      if (args.evidence.some(id => !sources.includes(id))) throw new Error('Decision evidence must come from the assigned learning batch.')
      if (args.evaluation !== 'new' && !current) throw new Error('Read an existing decision before evaluating it.')
      if (args.evaluation === 'new' && current) throw new Error('Existing decisions must be supported, corrected or retired, not recreated.')
      const evidence = batch.sources.filter(source => args.evidence.includes(source.sessionId))
        .map(source => `${source.sessionId} / ${source.physicalId} [${source.offset}, ${source.end})`)
      if (!evidence.length) evidence.push(...batch.inputEvents.filter(event => args.evidence.includes(event.origin)).map(event => `${event.origin} / event ${event.id}`))
      const content = [
        `# ${args.title}`, '', `Kind: ${args.kind}`, `Evidence interpretation: ${args.confidence}`,
        `Evaluation: ${args.evaluation}`, `Status: ${args.evaluation === 'retired' ? 'retired; do not apply' : args.confidence === 'inferred' ? 'provisional hypothesis; verify before applying' : 'scoped observation; not authorization'}`,
        '', '## When this applies', args.condition, '', '## Goal', args.goal, '', '## Why', args.rationale,
        '', '## Decision guidance', args.guidance, '', '## Exceptions and counterexamples', args.exceptions,
        '', '## Revalidate when', args.reviewWhen, '', '## Evidence', ...evidence.map(item => `- ${item}`),
        '', 'Historical reference only. New instructions and current evidence take precedence within their authority.', '',
      ].join('\n')
      if (args.revision !== currentRevision) throw new Error('Decision changed since read. Read it again before editing.')
      await createMemoryHandler(this.runtime.sessions.workspace, this.runtime.projectId).write(
        `decisions/${args.name}.md`, { content }, context)
      const saved = readFileSync(file, 'utf8')
      if (saved !== content) throw new Error('Memory write did not persist the requested decision.')
      this.runtime.ledger.artifact(batch.id, { path, revision: fingerprint(saved), kind: 'memory' },
        args.evaluation === 'new' ? undefined : `${path}:${evidence.join('|')}`)
      if (batch.pipeline === 'reflector') this.appendEvent({
        who: 'reflector', summary: `Decision ${args.evaluation}: ${Array.from(args.title).slice(0, 180).join('')}${Array.from(args.title).length > 180 ? '…' : ''}. Consult the decision and source evidence before applying.`,
        what: `${args.evaluation}: ${args.title}`, why: args.rationale,
        refs: [path], origin: args.evidence[0],
      }, `decision:${args.name}`, context)
      return JSON.stringify({ path, revision: fingerprint(saved), evaluation: args.evaluation })
    }),
  }

  readonly skill: Tool = {
    name: 'learned_skill', optIn: true,
    description: 'Read/check/save/patch a lesson-only Project skill with revision checking and immediate discovery. Use patch for a unique exact correction to an existing lesson; it runs the same final whole-lesson size/package/discovery checks as save. Correct superseded guidance first, separately from optional expansion. If correction cannot fit, save a complete reorganization preserving safety conditions and evidence; never truncate. Complete replacement, not append-only: consolidate duplicates while preserving conditions, evidence and exceptions. Save validates size, package and revision and persists in one call; a separate check is optional size feedback, not a prerequisite. Max 8000 UTF-16 code units, target <=7200. Does not install code, tools, agents or admin capabilities.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'check', 'save', 'patch'] }, name: { type: 'string' },
      match: { type: 'string', description: 'patch only: nonempty exact text occurring once in current SKILL.md. Read first; no fuzzy/global matching.' },
      replacement: { type: 'string', description: 'patch only: replacement text, empty to delete. Final complete lesson must still fit 8000 UTF-16 code units. Correct superseded guidance before optional extensions.' },
      revision: { type: 'string', description: 'Read revision, or empty string for a missing skill.' },
      content: { type: 'string', description: 'Complete SKILL.md, including frontmatter. Save limit: 8000 UTF-16 code units after trim; target <=7200. check accepts oversized drafts without writing and returns size feedback.' },
    }, required: ['action', 'name'] },
    execute: (raw, context) => this.serial(async () => {
      const batch = this.authorize(context)
      if (batch.pipeline !== 'encapsulator' || !this.runtime.skillStore) throw new Error('Learned skills require the Project encapsulation runtime.')
      const request = z.union([readSchema, skillSchema, skillCheckSchema, skillPatchSchema]).parse(raw)
      // Patch becomes an ordinary complete save below, with identical validation.
      let args: z.infer<typeof readSchema> | z.infer<typeof skillSchema> | z.infer<typeof skillCheckSchema> = request.action === 'patch'
        ? { action: 'save', name: request.name, revision: request.revision, content: '' } : request
      const store = this.runtime.skillStore
      const current = store.read(args.name)
      const currentContent = current.files['SKILL.md']?.toString() ?? ''
      if (args.action === 'read') return JSON.stringify({ name: args.name, revision: current.revision ?? '', content: currentContent,
        contentLength: currentContent.length, limits: skillLimits })
      if (args.revision !== (current.revision ?? '')) throw new Error('Skill changed since read. Read it again and merge before checking or saving.')
      if (args.action === 'check') {
        const length = args.content.trim().length
        return JSON.stringify({ name: args.name, status: 'size_checked', saved: false, contentLength: length,
          withinLimit: length > 0 && length <= LEARNED_SKILL_MAX_LENGTH,
          overBy: Math.max(0, length - LEARNED_SKILL_MAX_LENGTH), limits: skillLimits,
          message: 'Size check only, not package validation or a write. Reorganize and deduplicate, preserving triggers, conditions, exceptions, uncertainty and evidence; never truncate. Save a complete replacement with this revision. Reserve capacity for learning_result; if it cannot fit, report partial with the unsaved scope.' })
      }
      if (request.action === 'patch') {
        if (!currentContent) throw new Error('Patch requires an existing lesson. Read it first or save a complete new lesson.')
        const start = currentContent.indexOf(request.match)
        if (start < 0 || currentContent.indexOf(request.match, start + 1) >= 0) {
          throw new Error('Patch match must occur exactly once. Read the current lesson and use unique exact text or save a complete reorganization.')
        }
        args = skillSchema.parse({ action: 'save', name: request.name, revision: request.revision,
          content: currentContent.slice(0, start) + request.replacement + currentContent.slice(start + request.match.length) })
      }
      const parsed = parseSkillFile(args.content, args.name)
      if (current.source === 'builtin' || Object.keys(current.files).some(path => path !== 'SKILL.md')
        || parsed.meta.admin || parsed.meta.tools || parsed.meta.toolsError || parsed.meta.core || parsed.meta.name !== args.name) {
        throw new Error('Automatic learning can only create/update standalone lesson skills, not builtins or executable packages.')
      }
      const result = await store.save(args.name, { 'SKILL.md': args.content }, args.revision || null, false, context.signal)
      if (!this.runtime.skills?.getSkillDirectory(args.name)) throw new Error('Saved lesson is not discoverable.')
      this.runtime.ledger.artifact(batch.id, { kind: 'skill', path: `skills/${args.name}/SKILL.md`, revision: result.revision })
      return JSON.stringify({ ...result, status: 'discoverable', executable: false })
    }),
  }

  readonly result: Tool = {
    name: 'learning_result', optIn: true,
    description: 'Submit the learning outcome once all work is finished. Runtime verifies recorded artifacts/events. no_change needs a reason and no effects. Session completion alone does not acknowledge learning.',
    parameters: { type: 'object', properties: {
      status: { type: 'string', enum: ['applied', 'no_change', 'partial', 'blocked', 'draft_only'] },
      summary: { type: 'string', description: 'What changed and why, or why no durable change is justified. Include unresolved blockers.' },
    }, required: ['status', 'summary'] },
    execute: (raw, context) => this.serial(async () => {
      let batch = this.authorize(context)
      const args = resultSchema.parse(raw)
      batch = await this.runtime.inspectEffects(batch, true, args.status === 'applied' || args.status === 'no_change', context.signal)
      const effects = batch.artifacts.length + batch.events.length
      if (args.status === 'applied' && !effects) throw new Error('No verified learning effects. Use no_change, blocked or draft_only instead.')
      if (args.status === 'no_change' && effects) throw new Error('This batch has persisted effects; report applied or partial instead.')
      if (args.status === 'applied' && batch.pipeline === 'reflector' && batch.artifacts.length && !batch.events.length) {
        throw new Error('Record a provenance-bearing log event for the direct memory changes before reporting applied.')
      }
      if (args.status === 'applied' || args.status === 'no_change') await this.runtime.verify(batch, false, context.signal)
      context.signal.throwIfAborted()
      this.runtime.ledger.propose(batch.id, args.status, args.summary)
      return LEARNING_RECEIPT_RECORDED
    }),
  }

  readonly soul: Tool = {
    name: 'learning_soul', optIn: true,
    description: 'Read or refine Project SOUL.md using at least two independent source sessions. Preserve continuity and notification obligations. Not a place for user profiles or temporary task facts.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'save'] }, revision: { type: 'string' },
      content: { type: 'string' }, rationale: { type: 'string' },
      evidence: { type: 'array', items: { type: 'string' } },
    }, required: ['action'] },
    execute: (raw, context) => this.serial(async () => {
      const batch = this.authorize(context)
      if (batch.pipeline !== 'soulReflector') throw new Error('Soul changes require a soul-reflection batch.')
      const args = z.union([z.object({ action: z.literal('read') }).strict(), z.object({
        action: z.literal('save'), revision, content: text, rationale: text, evidence: z.array(text).min(2),
      }).strict()]).parse(raw)
      const file = projectStoragePath(this.runtime.sessions.workspace, 'SOUL.md')
      if (existsSync(file)) {
        const stat = lstatSync(file)
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) throw new Error('SOUL.md must be a regular, unaliased Project file.')
      }
      const content = existsSync(file) ? readFileSync(file, 'utf8') : ''
      if (args.action === 'read') return JSON.stringify({ revision: content ? fingerprint(content) : '', content })
      if (args.revision !== (content ? fingerprint(content) : '')) throw new Error('SOUL.md changed; read before editing.')
      if (new Set(args.evidence).size < 2 || args.evidence.some(id => !batch.inputEvents.some(event => event.origin === id))) {
        throw new Error('Soul changes need evidence from at least two distinct source sessions in this batch.')
      }
      const continuity = 'If you change this file, tell the user'
      if (!args.content.includes(continuity)) throw new Error('Preserve the SOUL continuity and user-notification clause.')
      await new WriteTool(this.runtime.sessions.workspace, true).execute({ path: file, content: args.content }, context)
      const saved = readFileSync(file, 'utf8')
      if (saved !== args.content) throw new Error('Soul change did not persist.')
      this.runtime.ledger.artifact(batch.id, { kind: 'soul', path: 'SOUL.md', revision: fingerprint(saved) })
      return 'SOUL.md updated. Explain the change and its evidence in learning_result; the saved automation outcome is visible to the user.'
    }),
  }
}
