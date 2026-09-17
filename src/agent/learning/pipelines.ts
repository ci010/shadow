import { join } from 'node:path'
import { mkdir, writeFile } from 'node:fs/promises'
import type { SessionManager } from '../../sessions/session-manager.ts'
import { readFileIfExists, workspacePath } from '../../utils/paths.ts'
import { LEARNING_AUTOMATIONS, resolveAutomationSession } from '../../cron/contracts.ts'
import { CronDispatcher } from '../../cron/dispatch.ts'
import type { CronJob } from '../../cron/service.ts'

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
  signal?: AbortSignal,
): Promise<{ entries: SessionDiffEntry[]; newWatermark: ReflectWatermark }> {
  signal?.throwIfAborted()
  const allSessions = sessions.listSessions()
  // Filter out internal pipeline sessions
  const userSessions = allSessions.filter((s) => {
    if (s.sessionId.startsWith('heartbeat:') || s.sessionId.startsWith('sleep:')) return false
    const state = sessions.getSessionState?.(s.sessionId)
    return !state || resolveAutomationSession(state)?.config?.source !== 'learning'
  })

  const entries: SessionDiffEntry[] = []
  const newWatermarkSessions: Record<string, WatermarkSession> = {}

  for (const s of userSessions) {
    signal?.throwIfAborted()
    const { total } = await sessions.getHistory(s.sessionId, { offset: 0, pageSize: 0 })
    signal?.throwIfAborted()

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

export function learningJob(pipeline: keyof typeof LEARNING_AUTOMATIONS): CronJob {
  return { ...LEARNING_AUTOMATIONS[pipeline], source: 'learning', session: 'fresh', schedule: 'manual', createdAt: new Date().toISOString() }
}

export function learningTask(pipeline: 'encapsulator' | 'soulReflector'): string {
  const today = new Date().toISOString().slice(0, 10)
  return pipeline === 'encapsulator'
    ? `Encapsulate: read event log at memory/events/${today}.jsonl and referenced wiki items. Encapsulate recurring complexity into a skill, tool/CLI, or dedicated agent.`
    : `Soul Reflect: read event log at memory/events/${today}.jsonl and identity wiki items under memory/identities/. Refine SOUL.md based on stable interaction patterns.`
}

/**
 * Run the reflector **flush**: diff all sessions against the persisted
 * watermark, spawn the reflector on only the new/updated increment, then
 * advance the watermark. Returns true if a flush was started (false when
 * nothing changed). Shared by the periodic auto-flush and the `/learn` command.
 */
export async function triggerReflectorFlush(
  sessions: SessionManager,
  signal?: AbortSignal,
  dispatch?: (task: string) => Promise<string>,
): Promise<boolean> {
  signal?.throwIfAborted()
  const watermark = await readWatermark(sessions.workspace)
  const { entries, newWatermark } = await computeSessionDiff(sessions, watermark, signal)
  signal?.throwIfAborted()
  if (entries.length === 0) return false

  const sessionId = await (dispatch
    ? dispatch(buildReflectorTask(entries))
    : new CronDispatcher(sessions, async () => {}).dispatch(learningJob('reflector'), signal ?? new AbortController().signal, buildReflectorTask(entries)))
  if (!sessionId) throw new Error('Reflector session was not accepted')
  signal?.throwIfAborted()
  await writeWatermark(sessions.workspace, newWatermark)
  return true
}

export function triggerLearningPipeline(
  sessions: SessionManager,
  pipeline: keyof typeof LEARNING_AUTOMATIONS,
): Promise<boolean | string> {
  return pipeline === 'reflector' ? triggerReflectorFlush(sessions)
    : new CronDispatcher(sessions, async () => {}).dispatch(
      learningJob(pipeline), new AbortController().signal, learningTask(pipeline))
}
