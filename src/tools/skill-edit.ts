import { TextDecoder } from 'node:util'
import { z } from 'zod'
import type { SkillsManager } from '../skills/loader.ts'
import type { SkillEditStore } from '../skills/edit-store.ts'
import type { ExecutionContext } from './context.ts'
import type { SessionTools } from './registry.ts'
import type { Tool, ToolParameters } from './tool.ts'

const readSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1).optional(),
  offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(8000).default(8000),
}).strict()
const saveSchema = z.object({
  name: z.string().min(1),
  files: z.record(z.string().nullable()).refine(files => Object.keys(files).length > 0, 'Provide at least one file edit'),
}).strict()

export interface SkillEditingOptions {
  projectId: string
  store: SkillEditStore
  skills: SkillsManager
  canEdit: (sessionId: string) => boolean
}

/** Read baselines belong to an active session, not to shared model arguments. */
export class SkillEditing {
  private baselines = new WeakMap<SessionTools, Map<string, string | null>>()

  constructor(private options: SkillEditingOptions) {}

  private authorize(context: ExecutionContext): void {
    context.signal.throwIfAborted()
    if (context.projectId !== this.options.projectId || !this.options.canEdit(context.sessionId) ||
      context.remoteWorkdir || (context.tools.executionMode !== undefined && context.tools.executionMode !== 'session')) {
      throw new Error('Shared Skill editing requires a durable local Project session, not a managed Bot or temporary execution.')
    }
  }

  private remember(context: ExecutionContext, name: string, revision: string | null): void {
    if (!this.baselines.has(context.tools)) {
      context.tools.onReset(() => { this.baselines.delete(context.tools) })
    }
    const entries = this.baselines.get(context.tools) ?? new Map<string, string | null>()
    entries.delete(name)
    entries.set(name, revision)
    while (entries.size > 64) entries.delete(entries.keys().next().value!)
    this.baselines.set(context.tools, entries)
  }

  read(raw: Record<string, unknown>, context: ExecutionContext): string {
    this.authorize(context)
    const args = readSchema.parse(raw)
    const snapshot = this.options.store.read(args.name, context.admin)
    if (snapshot.source === 'missing') {
      this.remember(context, args.name, null)
      return JSON.stringify({ name: args.name, source: 'missing', files: [], message: 'Create with skill_save, including SKILL.md and any tool sources in one save.' })
    }
    const baseline = this.baselines.get(context.tools)?.get(args.name)
    if ((args.offset > 0 || args.path) && baseline !== undefined && baseline !== snapshot.revision) {
      throw new Error('Skill changed between reads. Restart skill_read without path/offset and merge the current content before saving.')
    }
    const path = args.path ?? 'SKILL.md'
    if (!args.path && !Object.hasOwn(snapshot.files, 'SKILL.md')) {
      this.remember(context, args.name, snapshot.revision)
      return JSON.stringify({
        name: args.name, source: snapshot.source, files: Object.keys(snapshot.files).sort(),
        path, content: null,
        message: 'This directory has resources but no SKILL.md. Save a new SKILL.md to restore the Skill; unedited resources are preserved.',
      })
    }
    if (!Object.hasOwn(snapshot.files, path)) throw new Error('Skill resource does not exist; use a path from the file listing.')
    let content: string
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(snapshot.files[path]) }
    catch (error) { throw new Error('This Skill resource is not UTF-8 text and cannot be edited with skill_save.', { cause: error }) }
    if (args.offset > content.length) throw new Error('Offset exceeds the Skill resource length.')
    const end = Math.min(content.length, args.offset + args.limit)
    this.remember(context, args.name, snapshot.revision)
    return JSON.stringify({
      name: args.name, source: snapshot.source, files: Object.keys(snapshot.files).sort(),
      path, content: content.slice(args.offset, end), offset: args.offset,
      totalCharacters: content.length, nextOffset: end < content.length ? end : null,
      message: snapshot.source === 'builtin'
        ? 'Built-in Skills are read-only. Create a differently named Project Skill to adapt this content.'
        : 'Edit with skill_save. The host remembers this read for conflict detection; no Change, revision argument, or publication is needed.',
    })
  }

  async save(raw: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    this.authorize(context)
    const args = saveSchema.parse(raw)
    const expected = this.baselines.get(context.tools)?.get(args.name) ?? null
    const current = this.options.store.read(args.name, context.admin)
    if (current.source !== 'missing' && !this.baselines.get(context.tools)?.has(args.name)) {
      throw new Error('Read the existing Skill with skill_read before editing it. No files were saved.')
    }
    const result = await this.options.store.save(args.name, args.files, expected, context.admin, context.signal)
    this.remember(context, args.name, result.revision)
    this.options.skills.markSkillUsed(args.name, context.sessionId)
    return JSON.stringify({
      name: result.name, files: result.files, path: `v:skills/${result.name}`, status: 'saved',
      message: 'Saved to the shared Project Skill space, without history backup. Read the Skill to load its current instructions and tools. Saving grants no execution permissions and changes no Bot deployment.',
    })
  }
}

export class SkillReadTool implements Tool {
  readonly name = 'skill_read'
  readonly optIn = true
  readonly description = 'Read raw shared Skill files for editing without activating tools. Omit path for SKILL.md and a file listing. Remembers the edit baseline internally. Use normal read on v:skills/<name> to use a Skill.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill directory name.' },
      path: { type: 'string', description: 'Optional exact relative file path from the listing; defaults to SKILL.md.' },
      offset: { type: 'integer', description: 'Character offset, default 0.' },
      limit: { type: 'integer', description: 'Characters per read, 1-8000.' },
    },
    required: ['name'], additionalProperties: false,
  }
  constructor(private editing: SkillEditing) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    return this.editing.read(args, context)
  }
}

export class SkillSaveTool implements Tool {
  readonly name = 'skill_save'
  readonly optIn = true
  readonly description = 'Create or edit a shared Project Skill directly, including its tool scripts. Send all related file edits in one save; null deletes a resource. Read existing Skills with skill_read first. Validates and conflict-checks without a Change or publication. No history backup, new execution grants or Bot deployment.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'Skill directory name, matching its frontmatter name.' },
      files: { type: 'object', description: 'Map of relative file paths to complete UTF-8 content, or null to delete. Include SKILL.md when creating; include all newly declared tool sources in the same save.' },
    },
    required: ['name', 'files'], additionalProperties: false,
  }
  constructor(private editing: SkillEditing) {}
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    return this.editing.save(args, context)
  }
}
