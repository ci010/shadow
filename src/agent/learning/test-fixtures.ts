import type { SessionManager } from '../../sessions/session-manager.ts'
import type { SessionState } from '../../sessions/session-store.ts'

export interface FakeState {
  sessionId: string
  segmentIndex: number
  total: number
}

/** Minimal SessionManager fake exposing only what learning dispatch touches. */
export function fakeSessions(workspace: string, states: FakeState[]) {
  const started: Array<{ agentType?: string; task?: string; signal?: AbortSignal }> = []
  const records = new Map<string, SessionState>(states.map(s => [s.sessionId, { sessionId: s.sessionId,
    segmentIndex: s.segmentIndex, projectId: 'a', physicalIdVersion: 2 }]))
  let respond: (id: string) => Promise<void> = async () => {}
  const sessions = {
    workspace,
    listSessions: () =>
      states.map((s) => ({
        sessionId: s.sessionId,
        segmentIndex: s.segmentIndex,
      })),
    getHistory: (sessionId: string) => {
      const s = states.find((x) => x.sessionId === sessionId)
      return Promise.resolve({ messages: [], total: s?.total ?? 0 })
    },
    getSessionState: (id: string) => records.get(id),
    isManagedConversation: () => false,
    getExecutionResult: async () => undefined,
    getFileChanges: async () => ({ changes: [], total: 0, offset: 0 }),
    startSession: async (opts: { chatId: string; agentType?: string; task?: string; signal?: AbortSignal; onAccepted?: (id: string) => void }) => {
      started.push(opts)
      const id = `cron:${opts.chatId}`
      records.set(id, { sessionId: id, segmentIndex: 0, projectId: 'a', executionStatus: 'running' })
      opts.onAccepted?.(id)
      await respond(id)
      records.get(id)!.executionStatus = 'completed'
      return id
    },
  } as unknown as SessionManager
  return { sessions, started, records, onRun: (callback: typeof respond) => { respond = callback } }
}
