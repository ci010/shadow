import type { ProjectUsage, ProjectUsageMetrics } from '../projects/usage-contract.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { parseTokenUsage } from './usage.ts'

const DAY = 86_400_000
function empty(): ProjectUsageMetrics {
  return { calls: 0, tokens: null, unknownTokenCalls: 0, costs: [], unknownCostCalls: 0, durationMs: null, unknownDurationCalls: 0 }
}
function add(target: ProjectUsageMetrics, record: Record<string, unknown>) {
  target.calls++
  const usage = parseTokenUsage(record.usage)
  if (usage) target.tokens = (target.tokens ?? 0) + usage.totalTokens
  else target.unknownTokenCalls++
  if (!usage?.costs || usage.costIncomplete) target.unknownCostCalls++
  for (const cost of usage?.costs ?? []) {
    const existing = target.costs.find(value => value.currency === cost.currency)
    if (existing) existing.amount += cost.amount
    else target.costs.push({ ...cost })
  }
  const duration = record.durationMs
  if (typeof duration === 'number' && Number.isFinite(duration) && duration >= 0) target.durationMs = (target.durationMs ?? 0) + duration
  else target.unknownDurationCalls++
}
/** One bounded source-log pass; never sums assistant snapshots or inherited fork history. */
async function scanProjectUsage(store: SessionStore, states: SessionState[], projectId: string, asOf: number, signal?: AbortSignal): Promise<ProjectUsage> {
  const today = Math.floor(asOf / DAY) * DAY
  const month = Date.UTC(new Date(asOf).getUTCFullYear(), new Date(asOf).getUTCMonth(), 1)
  const result: ProjectUsage = { projectId, asOf: new Date(asOf).toISOString(), timeZone: 'UTC', total: empty(), today: empty(), past7Days: empty(), month: empty(), daily: [], scanLimitReached: false, untrackedSessions: 0, undatedCalls: 0 }
  const daily = new Map<string, ProjectUsageMetrics>()
  // Include zero-activity days in the recent trend; older active days remain available.
  for (let time = today - 30 * DAY; time <= today; time += DAY) daily.set(new Date(time).toISOString().slice(0, 10), empty())
  const seen = new Set<string>(), physical = new Set<string>(), logical = new Set<string>()
  let scanned = 0
  const selected = states.filter(state => state.projectId === projectId && !logical.has(state.sessionId) && !!logical.add(state.sessionId))
  outer: for (let position = 0; position < selected.length; position++) {
    const state = selected[position]!
    let tracked = false
    for (let index = 0; index <= state.segmentIndex; index++) {
      signal?.throwIfAborted()
      const id = physicalSessionId(state, index)
      if (physical.has(id)) continue
      physical.add(id)
      for await (const record of store.readSessionLog(id)) {
        signal?.throwIfAborted()
        if (++scanned > 100_000) {
          result.scanLimitReached = true
          result.untrackedSessions += selected.length - position
          break outer
        }
        if (record.type !== 'model_usage' || record.sessionId !== state.sessionId || typeof record.id !== 'string') continue
        tracked = true
        const key = JSON.stringify([state.sessionId, record.id])
        if (seen.has(key)) continue
        seen.add(key)
        const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
        if (!Number.isFinite(time)) { result.undatedCalls++; continue }
        if (time >= asOf) continue
        add(result.total, record)
        if (time >= today) add(result.today, record)
        if (time >= today - 6 * DAY) add(result.past7Days, record)
        if (time >= month) add(result.month, record)
        const date = new Date(time).toISOString().slice(0, 10)
        const bucket = daily.get(date) ?? empty()
        add(bucket, record); daily.set(date, bucket)
      }
    }
    if (!tracked) result.untrackedSessions++
  }
  result.daily = [...daily].sort(([a], [b]) => b.localeCompare(a)).map(([date, usage]) => ({ date, usage }))
  return result
}

// Weak store ownership + one snapshot per Project; bounded lifetime/size, never HTTP cached.
const snapshots = new WeakMap<SessionStore, Map<string, { expires: number; value: ProjectUsage }>>()
async function snapshot(store: SessionStore, states: SessionState[], projectId: string, asOf: number, signal?: AbortSignal, refresh = false) {
  signal?.throwIfAborted()
  let cache = snapshots.get(store)
  if (!cache) { cache = new Map(); snapshots.set(store, cache) }
  const hit = cache.get(projectId)
  if (!refresh && hit && hit.expires > Date.now()) return hit.value
  const value = await scanProjectUsage(store, states, projectId, asOf, signal)
  signal?.throwIfAborted()
  if (cache.size >= 8) cache.delete(cache.keys().next().value!)
  cache.set(projectId, { expires: Date.now() + 60_000, value })
  return value
}
export async function readProjectUsage(store: SessionStore, states: SessionState[], projectId: string, asOf: number, signal?: AbortSignal): Promise<ProjectUsage> {
  const value = await snapshot(store, states, projectId, asOf, signal, true)
  const from = new Date(Math.floor(asOf / DAY) * DAY - 30 * DAY).toISOString().slice(0, 10)
  return { ...value, daily: value.daily.filter(day => day.date >= from) }
}
export async function readProjectUsagePage(store: SessionStore, states: SessionState[], projectId: string, asOf: number, page: number, signal?: AbortSignal) {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('Invalid usage page')
  const value = await snapshot(store, states, projectId, asOf, signal)
  const offset = (page - 1) * 10
  return { projectId, asOf: value.asOf, page, pageSize: 10 as const, total: value.daily.length, hasMore: offset + 10 < value.daily.length, daily: value.daily.slice(offset, offset + 10) }
}
