import type { Tool, ToolParameters } from '../tools/tool.ts'
import {
  applySessionMemoryUpdate,
  type SessionMemoryState,
  type SessionMemoryUpdate,
} from '../sessions/session-memory.ts'
import type { HandoffContext } from './manager.ts'

// ── Shared capture container ─────────────────────────────────────────

export interface HandoffCapture {
  context: HandoffContext | null
  memoryState: SessionMemoryState
  memoryUpdated: boolean
}

// ── Pure helpers (extracted from HandoffManager) ─────────────────────

export function clampString(
  value: unknown,
  fallback: string,
  maxLength: number,
): string {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.slice(0, maxLength)
}

export function clampStringArray(
  value: unknown,
  maxItems: number,
  fallback: string[],
): string[] {
  if (!Array.isArray(value)) return fallback
  const next = value
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .filter((item, index, arr) => arr.indexOf(item) === index)
    .slice(0, maxItems)
  return next.length > 0 ? next : fallback
}

export function parseHandoffArgs(
  args: Record<string, unknown>,
  fallback: HandoffContext,
): HandoffContext {
  return {
    summary: clampString(args.summary, fallback.summary, 4000),
    currentObjective: clampString(
      args.currentObjective,
      fallback.currentObjective,
      240,
    ),
    recentTranscript: clampStringArray(
      args.recentTranscript,
      24,
      fallback.recentTranscript,
    ),
  }
}

// ── HandoffSummaryTool ───────────────────────────────────────────────

export class HandoffSummaryTool implements Tool {
  readonly name = 'handoff_summary'
  readonly description =
    'Record the handoff context summary. You MUST call this tool before any other tool.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description:
          'Markdown summary of conversation (20% or less of transcript)',
      },
      currentObjective: {
        type: 'string',
        description: '1-2 sentence next objective',
      },
      recentTranscript: {
        type: 'array',
        items: { type: 'string' },
        description: 'Human-readable one-liners for recent turns',
      },
    },
    required: ['summary', 'currentObjective', 'recentTranscript'],
  }

  constructor(
    private capture: HandoffCapture,
    private fallback: HandoffContext,
  ) {}

  getChatTextDisplay(_args: Record<string, unknown>): string {
    return '📋 Recording handoff summary'
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    this.capture.context = parseHandoffArgs(args, this.fallback)
    return 'Handoff summary recorded.'
  }
}

// ── UpdateSessionMemoryTool ──────────────────────────────────────────

export class UpdateSessionMemoryTool implements Tool {
  readonly name = 'update_session_memory'
  readonly description =
    'Update structured session memory for this session. ' +
    'Only include fields you want to change — omitted fields keep existing values. ' +
    'Narrative fields (current_focus, progress_summary) replace the existing value. ' +
    'Item fields use add_*/remove_* operations. ' +
    'remove_* uses case-insensitive substring matching. ' +
    'Call this AFTER handoff_summary.'
  readonly parameters: ToolParameters = {
    type: 'object',
    properties: {
      current_focus: {
        type: 'string',
        description:
          '1-3 sentence current objective — what should the agent prioritize next? Replaces existing.',
      },
      progress_summary: {
        type: 'string',
        description:
          'Compressed narrative paragraph of accomplishments. Rewrite fully each time, do NOT append.',
      },
      add_themes: {
        type: 'array',
        description:
          'New active themes to add. Merge overlapping with existing before adding.',
        items: { type: 'string' },
      },
      remove_themes: {
        type: 'array',
        description:
          'Themes to remove (case-insensitive substring match).',
        items: { type: 'string' },
      },
      add_active_files: {
        type: 'array',
        description: 'Files currently relevant to ongoing work.',
        items: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: 'Workspace-relative file path',
            },
            description: {
              type: 'string',
              description: 'Brief relevance description',
            },
          },
          required: ['path', 'description'],
        },
      },
      remove_active_files: {
        type: 'array',
        description:
          'File paths to remove from active list (substring match on path).',
        items: { type: 'string' },
      },
      add_decisions: {
        type: 'array',
        description: 'Decisions currently in effect.',
        items: { type: 'string' },
      },
      remove_decisions: {
        type: 'array',
        description: 'Decisions to remove (substring match).',
        items: { type: 'string' },
      },
      add_open_tasks: {
        type: 'array',
        description: 'Actionable pending items.',
        items: { type: 'string' },
      },
      remove_open_tasks: {
        type: 'array',
        description:
          'Tasks to remove — completed or no longer relevant (substring match).',
        items: { type: 'string' },
      },
      add_rejected_approaches: {
        type: 'array',
        description:
          'Approaches tried and rejected. High-value for preventing retry loops and learning.',
        items: {
          type: 'object',
          properties: {
            approach: { type: 'string', description: 'What was tried' },
            outcome: {
              type: 'string',
              description: 'What happened / why it failed',
            },
            lesson: { type: 'string', description: 'What to do instead' },
          },
          required: ['approach', 'outcome', 'lesson'],
        },
      },
      remove_rejected_approaches: {
        type: 'array',
        description:
          'Rejected approaches to remove (substring match on the approach field). Rarely needed.',
        items: { type: 'string' },
      },
    },
  }

  constructor(private capture: HandoffCapture) {}

  getChatTextDisplay(_args: Record<string, unknown>): string {
    return '🧠 Updating session memory'
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const update = args as SessionMemoryUpdate
    this.capture.memoryState = applySessionMemoryUpdate(
      this.capture.memoryState,
      update,
    )
    this.capture.memoryUpdated = true
    const modifiedFields = Object.keys(update)
      .filter((k) => (update as Record<string, unknown>)[k] !== undefined)
    return `Session memory updated. Modified: ${modifiedFields.join(', ')}`
  }
}
