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

  read(raw: Record<string, unknown>, context: ExecutionContext, continuation = false): string {
    this.authorize(context)
    const args = readSchema.parse(raw)
    const snapshot = this.options.store.read(args.name, context.admin)
    const baseline = this.baselines.get(context.tools)?.get(args.name)
    if ((continuation || args.path) && baseline !== undefined && baseline !== snapshot.revision) {
      throw new Error('Skill changed between reads. Reread v:skills/.raw/<name> and merge the current content before saving.')
    }
    if (snapshot.source === 'missing') {
      this.remember(context, args.name, null)
      return JSON.stringify({ name: args.name, source: 'missing', files: [], message: 'Create with skill_save, including SKILL.md and any tool sources in one save.' })
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
    this.remember(context, args.name, snapshot.revision)
    return JSON.stringify({
      name: args.name, source: snapshot.source, files: Object.keys(snapshot.files).sort(),
      path, content,
      message: snapshot.source === 'builtin'
        ? 'Built-in Skills are read-only. Create a differently named Project Skill to adapt this content.'
        : 'Edit with skill_save. The host remembers this read for conflict detection; no Change, revision argument, or publication is needed.',
    })
  }

  /** Raw editing view: normal read handles line paging; no Skill activation. */
  readRaw(subpath: string, context: ExecutionContext, continuation = false): string {
    const [name, ...parts] = subpath.split('/')
    const snapshot = JSON.parse(this.read({ name, ...(parts.length ? { path: parts.join('/') } : {}) }, context, continuation))
    const { content, ...metadata } = snapshot
    return JSON.stringify(metadata, null, 2) + (content === undefined || content === null ? '' : `\n\n${content}`)
  }

  async save(raw: Record<string, unknown>, context: ExecutionContext): Promise<string> {
    this.authorize(context)
    const args = saveSchema.parse(raw)
    const expected = this.baselines.get(context.tools)?.get(args.name) ?? null
    const current = this.options.store.read(args.name, context.admin)
    if (current.source !== 'missing' && !this.baselines.get(context.tools)?.has(args.name)) {
      throw new Error('Read the existing Skill with read on v:skills/.raw/<name> before editing it. No files were saved.')
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

export class SkillSaveTool implements Tool {
  readonly name = 'skill_save'
  readonly optIn = true
  readonly description = 'Create or edit a shared Project Skill directly, including its tool scripts. Send all related file edits in one save; null deletes a resource. Read existing Skills with read on v:skills/.raw/<name> first. Validates and conflict-checks without a Change or publication. No history backup, new execution grants or Bot deployment.'
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
