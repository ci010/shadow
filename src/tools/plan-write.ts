import { dirname, resolve } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import type { Tool, ToolParameters } from './tool.ts'
import { applyReplacement } from './filesystem.ts'
import { isWindows } from '../utils/runtime.ts'

/**
 * Scoped write tool for the plan agent.
 * Only writes to `<workspace>/.plans/` — prevents arbitrary file writes.
 */
export class PlanWriteTool implements Tool {
  readonly name = 'plan_write'
  readonly description =
    'Write or edit a planning document in .plans/. Shared task status belongs in Initiative items, not a second checklist.'
  readonly optIn = true
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'File path relative to .plans/ (e.g. "my-plan.md"). Subdirectories allowed.',
      },
      content: {
        type: 'string',
        description:
          'Full file content, or replacement text when match is set.',
      },
      match: {
        type: 'string',
        description: 'Exact text to find for edit mode (find and replace).',
      },
    },
    required: ['path', 'content'],
  }

  private plansDir: string

  constructor(workspace: string) {
    this.plansDir = resolve(workspace, '.plans')
  }

  getChatTextDisplay(args: Record<string, unknown>): string {
    const icon = args.match ? '✏️' : '📝'
    return `${icon} .plans/${String(args.path)}`
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const rawPath = String(args.path)

    // Reject path traversal
    if (rawPath.includes('..')) {
      return 'Error: path must not contain ".."'
    }

    const filePath = resolve(this.plansDir, rawPath)

    // Double-check resolved path is within .plans/
    const sep = isWindows ? '\\' : '/'
    const normalizedPlans = resolve(this.plansDir)
    const normalizedFile = resolve(filePath)
    if (
      !normalizedFile.startsWith(normalizedPlans + sep) &&
      normalizedFile !== normalizedPlans
    ) {
      return 'Error: path must stay within .plans/ directory'
    }

    const content = String(args.content)
    const match = args.match != null ? String(args.match) : undefined

    if (match !== undefined) {
      // Edit mode: find and replace
      let existing: string
      try {
        existing = await readFile(filePath, 'utf8')
      } catch {
        return `Error: file not found: .plans/${rawPath}`
      }
      const updated = applyReplacement(existing, match, content)
      if (updated === null) {
        return 'Error: match string not found in file'
      }
      await writeFile(filePath, updated)
      return `✏️ .plans/${rawPath}`
    }

    // Full write mode
    await mkdir(dirname(filePath), { recursive: true })
    await writeFile(filePath, content)
    return `📝 .plans/${rawPath}`
  }
}
