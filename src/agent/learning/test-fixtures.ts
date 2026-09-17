import type { SessionManager } from '../../sessions/session-manager.ts'

export interface FakeState {
  sessionId: string
  segmentIndex: number
  total: number
}

/** Minimal SessionManager fake exposing only what learning dispatch touches. */
export function fakeSessions(workspace: string, states: FakeState[]) {
  const started: Array<{ agentType?: string; task?: string; signal?: AbortSignal }> = []
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
    getSessionState: () => undefined,
    startSession: (opts: { agentType?: string; task?: string; signal?: AbortSignal }) => {
      started.push(opts)
      return Promise.resolve('spawned')
    },
  } as unknown as SessionManager
  return { sessions, started }
}
