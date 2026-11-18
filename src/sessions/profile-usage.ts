import { statsIndex } from './stats-index.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { parseTokenUsage } from './usage.ts'
import type { UsageMetrics } from './profile-contract.ts'

export function emptyUsage(): UsageMetrics {
  return { providerCalls: 0, knownUsageCalls: 0, unknownUsageCalls: 0, inputTokens: null, outputTokens: null, totalTokens: null, toolCalls: 0, trackedSessions: 0, untrackedSessions: 0 }
}
/** Reads source events only. Assistant usage snapshots are deliberately never summed. */
export async function readUsage(store: SessionStore, states: SessionState[], from: number, asOf: number, signal?: AbortSignal): Promise<UsageMetrics> {
  const result = emptyUsage()
  const seen = new Set<string>(), tools = new Set<string>()
  const stats = statsIndex(store)
  if (stats) {
    result.coverage = stats.complete ? 'complete' : 'partial'
    const sessions = new Set(states.map(state => state.sessionId))
    for (const session of sessions) {
      signal?.throwIfAborted()
      const item = stats.profile(session, from, asOf)
      result.providerCalls += item.calls
      result.knownUsageCalls += item.known
      result.unknownUsageCalls += item.calls - item.known
      if (item.input !== null) result.inputTokens = (result.inputTokens ?? 0) + item.input
      if (item.output !== null) result.outputTokens = (result.outputTokens ?? 0) + item.output
      if (item.total !== null) result.totalTokens = (result.totalTokens ?? 0) + item.total
      result.toolCalls += item.tools
      if (item.tracked) result.trackedSessions++; else result.untrackedSessions++
    }
    return result
  }
  let scanned = 0
  // Foreground aggregate reads never start a profiler loop or consume unbounded history.
  outer: for (const state of states) {
    let tracked = false
    for (let index = 0; index <= state.segmentIndex; index++) {
      signal?.throwIfAborted()
      for await (const record of store.readSessionLog(physicalSessionId(state, index))) {
        signal?.throwIfAborted()
        if (++scanned > 100_000) {
          result.scanLimitReached = true
          result.untrackedSessions += states.length - result.trackedSessions - result.untrackedSessions
          break outer
        }
        if (record.type === 'model_usage' && record.sessionId === state.sessionId && typeof record.id === 'string') tracked = true
        const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
        if (!(time >= from && time < asOf)) continue
        if (record.type === 'model_usage' && record.sessionId === state.sessionId && typeof record.id === 'string') {
          const key = `${state.sessionId}:${record.id}`
          if (seen.has(key)) continue
          seen.add(key); result.providerCalls++
          const usage = parseTokenUsage(record.usage)
          if (!usage) { result.unknownUsageCalls++; continue }
          result.knownUsageCalls++
          result.inputTokens = (result.inputTokens ?? 0) + usage.promptTokens
          result.outputTokens = (result.outputTokens ?? 0) + usage.completionTokens
          result.totalTokens = (result.totalTokens ?? 0) + usage.totalTokens
        } else if (record.role === 'tool' && typeof record.tool_call_id === 'string') {
          const key = `${state.sessionId}:${record.tool_call_id}`
          if (!tools.has(key)) { tools.add(key); result.toolCalls++ }
        }
      }
    }
    if (tracked) result.trackedSessions++; else result.untrackedSessions++
  }
  return result
}
