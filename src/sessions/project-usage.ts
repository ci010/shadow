import type { ProjectUsageActivity, ProjectUsage, ProjectUsageMetrics } from '../projects/usage-contract.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { parseTokenUsage } from './usage.ts'

const DAY = 86_400_000
function emptyActivity(): ProjectUsageActivity {
  return { total: { models: [], tools: [] }, today: { models: [], tools: [] }, past7Days: { models: [], tools: [] }, month: { models: [], tools: [] } }
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function argumentsObject(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'string') return object(value)
  try { return object(JSON.parse(value)) } catch { return undefined }
}
function toolNames(name: unknown, args: unknown): string[] {
  if (typeof name !== 'string' || !name.trim()) return []
  const parameters = argumentsObject(args)
  if (name === 'invoke_tool' || name === 'functions.invoke_tool') {
    return typeof parameters?.name === 'string' && parameters.name.trim() ? [parameters.name] : []
  }
  // Wrappers are not tools themselves. Resolve each dispatched target, including
  // dynamic invoke_tool targets, rather than attributing calls to the wrapper.
  if (name === 'multi_tool_use.parallel' || name === 'multi_tool_use') {
    return Array.isArray(parameters?.tool_uses) ? parameters.tool_uses.flatMap(value => {
      const call = object(value)
      return call ? toolNames(call.recipient_name, call.parameters) : []
    }) : []
  }
  return [name.startsWith('functions.') ? name.slice('functions.'.length) : name]
}
function addActivity(activity: ProjectUsageActivity, kind: 'models' | 'tools', names: string[], time: number, today: number, month: number) {
  for (const period of ['total', ...(time >= today ? ['today' as const] : []), ...(time >= today - 6 * DAY ? ['past7Days' as const] : []), ...(time >= month ? ['month' as const] : [])] as const) {
    for (const name of names) {
      const entries = activity[period][kind]
      const entry = entries.find(value => value.name === name)
      if (entry) entry.calls++
      else entries.push({ name, calls: 1 })
    }
  }
}
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
  const result: ProjectUsage = { activity: emptyActivity(), projectId, asOf: new Date(asOf).toISOString(), timeZone: 'UTC', total: empty(), today: empty(), past7Days: empty(), month: empty(), daily: [], scanLimitReached: false, untrackedSessions: 0, undatedCalls: 0 }
  const daily = new Map<string, ProjectUsageMetrics>()
  // Include zero-activity days in the recent trend; older active days remain available.
  for (let time = today - 30 * DAY; time <= today; time += DAY) daily.set(new Date(time).toISOString().slice(0, 10), empty())
  const seen = new Set<string>(), physical = new Set<string>(), logical = new Set<string>()
  let scanned = 0
  const selected = states.filter(state => state.projectId === projectId && !logical.has(state.sessionId) && !!logical.add(state.sessionId))
  outer: for (let position = 0; position < selected.length; position++) {
    const state = selected[position]!
    let tracked = false
    const calls = new Map<string, { name: unknown; args: unknown }>()
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
        // Raw physical logs contain only locally persisted messages; fork context
        // is resolved separately by history readers. Tool messages normally have
        // no sessionId. Never scan resolved/inherited history here.
        if (record.sessionId !== undefined && record.sessionId !== state.sessionId) continue
        if (record.role === 'assistant' && Array.isArray(record.tool_calls)) {
          for (const value of record.tool_calls) {
            const call = object(value), fn = object(call?.function)
            if (typeof call?.id === 'string' && fn) calls.set(call.id, { name: fn.name, args: fn.arguments })
          }
        }
        if (record.role === 'tool' && typeof record.tool_call_id === 'string') {
          const key = JSON.stringify(['tool', state.sessionId, record.tool_call_id])
          const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
          if (!seen.has(key) && Number.isFinite(time) && time < asOf) {
            seen.add(key)
            const call = calls.get(record.tool_call_id)
            addActivity(result.activity, 'tools', toolNames(call?.name ?? record.name, call?.args), time, today, month)
          }
          continue
        }
        if (record.type !== 'model_usage' || record.sessionId !== state.sessionId || typeof record.id !== 'string') continue
        tracked = true
        const key = JSON.stringify([state.sessionId, record.id])
        if (seen.has(key)) continue
        seen.add(key)
        const time = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN
        if (!Number.isFinite(time)) { result.undatedCalls++; continue }
        if (time >= asOf) continue
        if (typeof record.model === 'string' && record.model.trim()) addActivity(result.activity, 'models', [record.model], time, today, month)
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
  for (const period of Object.values(result.activity)) {
    for (const entries of [period.models, period.tools]) entries.sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
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
