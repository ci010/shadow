import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { SessionManager } from '../../sessions/session-manager.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'
import type { SlashCommandHandler } from '../index.ts'

// ── Reflector watermark ────────────────────────────────────────────────────

const WATERMARK_FILE = 'memory/.reflect-watermark.json'

interface WatermarkSession {
  segmentIndex: number
  messageCount: number
}

interface ReflectWatermark {
  lastRunAt: string
  sessions: Record<string, WatermarkSession>
}

async function readWatermark(workspace: string): Promise<ReflectWatermark | null> {
  const raw = await readFileIfExists(workspacePath(workspace, WATERMARK_FILE))
  if (!raw) return null
  try {
    return JSON.parse(raw) as ReflectWatermark
  } catch {
    return null
  }
}

async function writeWatermark(workspace: string, watermark: ReflectWatermark): Promise<void> {
  const filePath = workspacePath(workspace, WATERMARK_FILE)
  await mkdir(join(filePath, '..'), { recursive: true })
  await writeFile(filePath, JSON.stringify(watermark, null, 2) + '\n')
}

type SessionDiffEntry = {
  sessionId: string
  status: 'new' | 'updated-segment' | 'updated-content'
  /** For updated-content: skip this many messages (already processed). */
  offset?: number
}

async function computeSessionDiff(
  sessions: SessionManager,
  watermark: ReflectWatermark | null,
): Promise<{ entries: SessionDiffEntry[]; newWatermark: ReflectWatermark }> {
  const allSessions = sessions.listSessions()
  // Filter out internal pipeline sessions
  const userSessions = allSessions.filter((s) => !s.sessionId.startsWith('heartbeat:'))

  const entries: SessionDiffEntry[] = []
  const newWatermarkSessions: Record<string, WatermarkSession> = {}

  for (const s of userSessions) {
    const { total } = await sessions.getHistory(s.sessionId, { offset: 0, pageSize: 0 })

    // Record current state for the new watermark
    newWatermarkSessions[s.sessionId] = {
      segmentIndex: s.segmentIndex,
      messageCount: total,
    }

    const prev = watermark?.sessions[s.sessionId]
    if (!prev) {
      // New session — never processed
      entries.push({ sessionId: s.sessionId, status: 'new' })
    } else if (s.segmentIndex > prev.segmentIndex) {
      // Session was compacted — new segment exists
      entries.push({ sessionId: s.sessionId, status: 'updated-segment' })
    } else if (total > prev.messageCount) {
      // Same segment but new messages added
      entries.push({
        sessionId: s.sessionId,
        status: 'updated-content',
        offset: prev.messageCount,
      })
    }
    // else: unchanged — skip
  }

  return {
    entries,
    newWatermark: {
      lastRunAt: new Date().toISOString(),
      sessions: newWatermarkSessions,
    },
  }
}

function buildReflectorTask(entries: SessionDiffEntry[]): string {
  if (entries.length === 0) {
    return 'Reflect: no new or updated sessions since last run. Nothing to process.'
  }

  const lines = ['Reflect: review the following sessions.\n']
  for (const e of entries) {
    if (e.status === 'new') {
      lines.push(`- [new] ${e.sessionId} — read from the beginning`)
    } else if (e.status === 'updated-segment') {
      lines.push(`- [updated-segment] ${e.sessionId} — session was compacted, read from the beginning`)
    } else {
      lines.push(`- [updated] ${e.sessionId} — read new messages starting at index ${e.offset}`)
    }
  }
  return lines.join('\n')
}

// ── Pipelines ──────────────────────────────────────────────────────────────

interface PipelineDef {
  agentType: string
  taskFn: (sessions: SessionManager) => Promise<string> | string
  /** Called after the session is started (e.g. to persist watermark). */
  afterStart?: (sessions: SessionManager) => Promise<void>
}

function createPipelines(): Record<string, PipelineDef> {
  // Shared state so afterStart can access the computed watermark
  let pendingWatermark: { workspace: string; watermark: ReflectWatermark } | null = null

  return {
    'reflector': {
      agentType: 'reflector',
      async taskFn(sessions) {
        const watermark = await readWatermark(sessions.workspace)
        const { entries, newWatermark } = await computeSessionDiff(sessions, watermark)
        pendingWatermark = { workspace: sessions.workspace, watermark: newWatermark }
        return buildReflectorTask(entries)
      },
      async afterStart() {
        if (pendingWatermark) {
          await writeWatermark(pendingWatermark.workspace, pendingWatermark.watermark)
          pendingWatermark = null
        }
      },
    },
    'encapsulator': {
      agentType: 'encapsulator',
      taskFn: () => {
        const today = new Date().toISOString().slice(0, 10)
        return `Encapsulate: manual trigger — read event log at memory/events/${today}.jsonl and referenced wiki items. Encapsulate recurring complexity into a skill, tool/CLI, or dedicated agent.`
      },
    },
    'soul-reflector': {
      agentType: 'soul-reflector',
      taskFn: () => {
        const today = new Date().toISOString().slice(0, 10)
        return `Soul Reflect: manual trigger — read event log at memory/events/${today}.jsonl and identity wiki items under memory/identities/. Refine SOUL.md based on stable interaction patterns.`
      },
    },
  }
}

/**
 * Run the reflector **flush**: diff all sessions against the persisted
 * watermark, spawn the reflector on only the new/updated increment, then
 * advance the watermark. Returns true if a flush was started (false when
 * nothing changed). Shared by the periodic auto-flush and the `/learn` command.
 */
export async function triggerReflectorFlush(
  sessions: SessionManager,
): Promise<boolean> {
  const watermark = await readWatermark(sessions.workspace)
  const { entries, newWatermark } = await computeSessionDiff(sessions, watermark)
  if (entries.length === 0) return false

  const sessionId = await sessions.startSession({
    channel: 'heartbeat',
    agentType: 'reflector',
    task: buildReflectorTask(entries),
  })
  if (!sessionId) throw new Error('Reflector session was not accepted')
  await writeWatermark(sessions.workspace, newWatermark)
  return true
}

export function createLearnCommand(
  sessions: SessionManager,
): SlashCommandHandler {
  const VALID_NAMES = Object.keys(createPipelines())

  return {
    name: 'learn',
    description: `Trigger a learning pipeline. Usage: /learn <${VALID_NAMES.join('|')}>`,
    adminOnly: true,
    async execute(_ctx, args): Promise<string> {
      const name = args.trim().toLowerCase()

      if (!name) {
        return `Usage: /learn <${VALID_NAMES.join('|')}>\n\nPipelines:\n${
          VALID_NAMES.map((n) => `  - ${n}`).join('\n')
        }`
      }

      const pipeline = createPipelines()[name]
      if (!pipeline) {
        return `Unknown pipeline "${name}". Available: ${VALID_NAMES.join(', ')}`
      }

      const task = await pipeline.taskFn(sessions)

      const sessionId = await sessions.startSession({
        agentType: pipeline.agentType,
        task,
      })
      if (!sessionId) throw new Error(`${name} session was not accepted`)

      await pipeline.afterStart?.(sessions)

      return `Triggered ${name}.`
    },
  }
}
