import type { ExecutionContext } from './context.ts'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import type { Tool, ToolParameters } from './tool.ts'
import { workspacePath } from '../utils/paths.ts'

const NAME_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

function projectDir(workspace: string, name: string): string {
  return workspacePath(workspace, 'projects', name)
}

function projectFile(workspace: string, name: string): string {
  return workspacePath(workspace, 'projects', name, 'project.md')
}

/**
 * Tool for managing long-running projects.
 * Projects provide shared context and progress tracking across subagents.
 */
export class ProjectTool implements Tool {
  readonly name = 'project'
  readonly description =
    'Manage long-running projects that coordinate multiple subagents. ' +
    'Workflow: 1) project(action="create") with goal and context, ' +
    '2) subagent(project_name="...") to spawn scoped subagents (they see project.md and can update it), ' +
    '3) project(action="status") to check progress, ' +
    '4) spawn more subagents as needed — each picks up via project.md, ' +
    '5) project(action="close") when done. ' +
    'Other actions: update (append to progress/notes), list (show all projects).'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['create', 'update', 'status', 'close', 'list'],
        description: 'Project lifecycle action.',
      },
      name: {
        type: 'string',
        description:
          '(create/update/status/close) Project name — lowercase alphanumeric + hyphens, max 64 chars.',
      },
      goal: {
        type: 'string',
        description: '(create) One-line description of the project goal.',
      },
      context: {
        type: 'string',
        description: '(create) Initial context for the project.',
      },
      content: {
        type: 'string',
        description: '(update) Content to append to the specified section.',
      },
      section: {
        type: 'string',
        enum: ['progress', 'notes', 'full'],
        description:
          '(update) Which section to update. Defaults to "progress". Use "full" to replace the entire file.',
      },
    },
    required: ['action'],
  }

  constructor(private workspace: string) {}

  async execute(
    args: Record<string, unknown>,
    _ctx: ExecutionContext,
  ): Promise<string> {
    const action = String(args.action)
    switch (action) {
      case 'create':
        return this.create(args)
      case 'update':
        return this.update(args)
      case 'status':
        return this.status(args)
      case 'close':
        return this.close(args)
      case 'list':
        return this.list()
      default:
        return `Error: unknown action "${action}". Use create, update, status, close, or list.`
    }
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const action = String(args.action)
    const name = args.name ? String(args.name) : ''
    switch (action) {
      case 'create':
        return `📁 Create project: ${name}`
      case 'update':
        return `📝 Update project: ${name}`
      case 'status':
        return `📋 Project status: ${name}`
      case 'close':
        return `✅ Close project: ${name}`
      case 'list':
        return '📁 List projects'
      default:
        return `project ${action}`
    }
  }

  private async create(args: Record<string, unknown>): Promise<string> {
    const name = args.name != null ? String(args.name) : ''
    if (!NAME_RE.test(name)) {
      return 'Error: name must be 1-64 chars, lowercase alphanumeric + hyphens, starting with alphanumeric.'
    }
    const goal = args.goal != null ? String(args.goal) : '(no goal specified)'
    const context = args.context != null ? String(args.context) : '(no context provided)'

    const dir = projectDir(this.workspace, name)
    const file = projectFile(this.workspace, name)

    try {
      await stat(file)
      return `Error: project "${name}" already exists. Use action="status" to view it.`
    } catch {
      // does not exist — proceed
    }

    await mkdir(dir, { recursive: true })

    const content = [
      `# Project: ${name}`,
      '',
      `**Status**: active`,
      `**Created**: ${new Date().toISOString()}`,
      `**Goal**: ${goal}`,
      '',
      '## Context',
      '',
      context,
      '',
      '## Progress',
      '',
      '(No progress yet)',
      '',
      '## Notes',
      '',
      '(No notes yet)',
      '',
    ].join('\n')

    await writeFile(file, content)
    return `Project "${name}" created at projects/${name}/project.md`
  }

  private async update(args: Record<string, unknown>): Promise<string> {
    const name = args.name != null ? String(args.name) : ''
    if (!name) return 'Error: name is required for update.'

    const file = projectFile(this.workspace, name)
    let existing: string
    try {
      existing = await readFile(file, 'utf8')
    } catch {
      return `Error: project "${name}" not found.`
    }

    const content = args.content != null ? String(args.content) : ''
    if (!content) return 'Error: content is required for update.'

    const section = args.section != null ? String(args.section) : 'progress'

    if (section === 'full') {
      await writeFile(file, content)
      return `Project "${name}" fully replaced.`
    }

    const heading = section === 'notes' ? '## Notes' : '## Progress'
    const idx = existing.indexOf(heading)
    if (idx === -1) {
      // Heading not found — append at end
      await writeFile(file, existing.trimEnd() + '\n\n' + heading + '\n\n' + content + '\n')
      return `Project "${name}" updated (appended ${section} section).`
    }

    // Find start of section content (after heading line)
    const afterHeading = existing.indexOf('\n', idx)
    if (afterHeading === -1) {
      await writeFile(file, existing + '\n\n' + content + '\n')
      return `Project "${name}" ${section} updated.`
    }

    // Find the next ## heading to know where the section ends
    const nextHeading = existing.indexOf('\n## ', afterHeading + 1)
    const sectionEnd = nextHeading === -1 ? existing.length : nextHeading

    // Remove placeholder text if present
    const sectionContent = existing.slice(afterHeading + 1, sectionEnd)
    const isPlaceholder = sectionContent.trim().startsWith('(No ')

    let updated: string
    if (isPlaceholder) {
      // Replace placeholder with actual content
      updated = existing.slice(0, afterHeading + 1) + '\n' + content + '\n' + existing.slice(sectionEnd)
    } else {
      // Append to existing section content
      updated = existing.slice(0, sectionEnd).trimEnd() + '\n' + content + '\n' + existing.slice(sectionEnd)
    }

    await writeFile(file, updated)
    return `Project "${name}" ${section} updated.`
  }

  private async status(args: Record<string, unknown>): Promise<string> {
    const name = args.name != null ? String(args.name) : ''
    if (!name) return 'Error: name is required for status.'

    const file = projectFile(this.workspace, name)
    try {
      return await readFile(file, 'utf8')
    } catch {
      return `Error: project "${name}" not found.`
    }
  }

  private async close(args: Record<string, unknown>): Promise<string> {
    const name = args.name != null ? String(args.name) : ''
    if (!name) return 'Error: name is required for close.'

    const file = projectFile(this.workspace, name)
    let existing: string
    try {
      existing = await readFile(file, 'utf8')
    } catch {
      return `Error: project "${name}" not found.`
    }

    const updated = existing.replace(
      '**Status**: active',
      `**Status**: completed\n**Completed**: ${new Date().toISOString()}`,
    )
    await writeFile(file, updated)
    return `Project "${name}" marked as completed.`
  }

  private async list(): Promise<string> {
    const dir = workspacePath(this.workspace, 'projects')
    let entries: Dirent[]
    try {
      entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory())
    } catch {
      return 'No projects found.'
    }

    if (entries.length === 0) return 'No projects found.'

    const lines: string[] = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = projectFile(this.workspace, entry.name)
      try {
        const content = await readFile(file, 'utf8')
        const statusMatch = content.match(/\*\*Status\*\*:\s*(\w+)/)
        const goalMatch = content.match(/\*\*Goal\*\*:\s*(.+)/)
        const status = statusMatch?.[1] ?? 'unknown'
        const goal = goalMatch?.[1]?.slice(0, 80) ?? ''
        lines.push(`- **${entry.name}** [${status}] ${goal}`)
      } catch {
        lines.push(`- **${entry.name}** [error reading]`)
      }
    }

    return lines.join('\n')
  }
}
