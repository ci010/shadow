import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
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
const skillSchema = z.object({ action: z.literal('save'), name: slug, revision, content: text }).strict()
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
  appendEvent(entry: { who: string; what: string; why?: string; challenge?: string; refs?: string[]; origin?: string },
    key: unknown, context: ExecutionContext): string | undefined {
    if (!this.runtime.ledger.batchFor(context.sessionId)) return undefined
    const batch = this.authorize(context)
    if (batch.pipeline !== 'reflector') throw new Error('Downstream learning consumes events; it does not re-log them.')
    const origin = text.parse(entry.origin)
    if (!batch.sources.some(source => source.sessionId === origin)) throw new Error('Event provenance is outside this learning batch.')
    const id = fingerprint(`${batch.id}:${origin}:${text.parse(key)}`)
    const previous = batch.events.find(event => event.id === id)
    if (previous) return `Learning event already recorded: ${id}`
    const when = new Date().toISOString()
    const path = `memory/events/${batch.createdAt.slice(0, 10)}.jsonl`
    const file = join(this.runtime.sessions.workspace, path)
    // Recover an append that committed immediately before the journal write/process failed.
    const prior = existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(line => JSON.parse(line) as LearningEvent).find(event => event.id === id) : undefined
    const event: LearningEvent = prior ?? { ...entry, origin, id, when, path }
    if (!prior) {
      mkdirSync(join(this.runtime.sessions.workspace, 'memory', 'events'), { recursive: true })
      appendFileSync(file, JSON.stringify(event) + '\n')
    }
    this.runtime.ledger.event(batch.id, event)
    return `Logged learning event: ${id}`
  }

  readonly memory: Tool = {
    name: 'learning_memory', optIn: true,
    description: 'Read or revise a conditional decision in Project memory. Save only reusable goals, reasoning or useful facts. Requires evidence from this batch and a read revision; feedback revises rather than multiplies memories.',
    parameters: {
      type: 'object', properties: {
        action: { type: 'string', enum: ['read', 'save'] }, name: { type: 'string', description: 'Stable lowercase-kebab-case decision name.' },
        revision: { type: 'string', description: 'Revision returned by read, or empty string for a missing decision.' },
        title: { type: 'string' }, kind: { type: 'string', enum: ['motivation', 'principle', 'fact', 'procedure'] },
        confidence: { type: 'string', enum: ['stated', 'inferred'] },
        evaluation: { type: 'string', enum: ['new', 'supported', 'corrected', 'retired'] },
        condition: { type: 'string' }, goal: { type: 'string' }, rationale: { type: 'string' },
        guidance: { type: 'string' }, exceptions: { type: 'string' }, reviewWhen: { type: 'string' },
        evidence: { type: 'array', items: { type: 'string' }, description: 'Source session IDs from this batch. Do not treat agent-generated repetition as independent support.' },
      }, required: ['action', 'name'],
    },
    execute: (raw, context) => this.serial(async () => {
      const batch = this.authorize(context)
      const args = z.union([readSchema, decisionSchema]).parse(raw)
      const path = `memory/decisions/${args.name}.md`
      const file = join(this.runtime.sessions.workspace, path)
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
        who: 'reflector', what: `${args.evaluation}: ${args.title}`, why: args.rationale,
        refs: [path], origin: args.evidence[0],
      }, `decision:${args.name}`, context)
      return JSON.stringify({ path, revision: fingerprint(saved), evaluation: args.evaluation })
    }),
  }

  readonly skill: Tool = {
    name: 'learned_skill', optIn: true,
    description: 'Read/save a lesson-only Project skill with revision checking and immediate discovery. Does not install code, tools, agents or admin capabilities.',
    parameters: { type: 'object', properties: {
      action: { type: 'string', enum: ['read', 'save'] }, name: { type: 'string' },
      revision: { type: 'string', description: 'Read revision, or empty string for a missing skill.' }, content: { type: 'string' },
    }, required: ['action', 'name'] },
    execute: (raw, context) => this.serial(async () => {
      const batch = this.authorize(context)
      if (batch.pipeline !== 'encapsulator' || !this.runtime.skillStore) throw new Error('Learned skills require the Project encapsulation runtime.')
      const args = z.union([readSchema, skillSchema]).parse(raw)
      const store = this.runtime.skillStore
      const current = store.read(args.name)
      if (args.action === 'read') return JSON.stringify({ name: args.name, revision: current.revision ?? '', content: current.files['SKILL.md']?.toString() ?? '' })
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
      return 'Learning result recorded. End the session now; final acknowledgement follows successful session completion.'
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
      const file = join(this.runtime.sessions.workspace, 'SOUL.md')
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
