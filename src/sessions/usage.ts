import { randomUUID } from 'node:crypto'
import type { LLMProvider, LLMResponseUsage } from '../providers/provider.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'

export function parseTokenUsage(value: unknown): LLMResponseUsage | null {
  if (!value || typeof value !== 'object' || !('promptTokens' in value)
    || !('completionTokens' in value) || !('totalTokens' in value)) return null
  const { promptTokens, completionTokens, totalTokens } = value
  if (typeof promptTokens !== 'number' || typeof completionTokens !== 'number' || typeof totalTokens !== 'number'
    || ![promptTokens, completionTokens, totalTokens].every(token => Number.isSafeInteger(token) && token >= 0)) return null
  const cachedTokens = "cachedTokens" in value ? value.cachedTokens : undefined
  const cacheReportedPromptTokens = "cacheReportedPromptTokens" in value ? value.cacheReportedPromptTokens : undefined
  if (cacheReportedPromptTokens !== undefined && (cachedTokens === undefined
    || typeof cacheReportedPromptTokens !== 'number' || !Number.isSafeInteger(cacheReportedPromptTokens)
    || cacheReportedPromptTokens < 0 || cacheReportedPromptTokens > promptTokens)) return null
  if (cachedTokens !== undefined && (typeof cachedTokens !== "number" || !Number.isSafeInteger(cachedTokens)
    || cachedTokens < 0 || cachedTokens > (cacheReportedPromptTokens ?? promptTokens))) return null
  return { promptTokens, completionTokens, totalTokens, ...(cachedTokens !== undefined ? { cachedTokens } : {}),
    ...(cacheReportedPromptTokens !== undefined ? { cacheReportedPromptTokens } : {}) }
}

export function addTokenUsage(first: LLMResponseUsage | null, second: LLMResponseUsage | null): LLMResponseUsage | null {
  if (!second) return first
  if (!first) return { ...second }
  const promptTokens = first.promptTokens + second.promptTokens
  const hasCacheReport = first.cachedTokens !== undefined || second.cachedTokens !== undefined
  const reportedPromptTokens = (first.cachedTokens === undefined ? 0 : first.cacheReportedPromptTokens ?? first.promptTokens)
    + (second.cachedTokens === undefined ? 0 : second.cacheReportedPromptTokens ?? second.promptTokens)
  const result = {
    promptTokens,
    completionTokens: first.completionTokens + second.completionTokens,
    totalTokens: first.totalTokens + second.totalTokens,
    ...(hasCacheReport ? {
      cachedTokens: (first.cachedTokens ?? 0) + (second.cachedTokens ?? 0),
      ...(reportedPromptTokens < promptTokens ? { cacheReportedPromptTokens: reportedPromptTokens } : {}),
    } : {}),
  }
  if (!parseTokenUsage(result)) throw new Error('Session token totals exceed the supported range.')
  return result
}

export function usageProvider(
  provider: LLMProvider, store: SessionStore, owner: () => { sessionId: string; physicalId: string },
): LLMProvider {
  return {
    name: provider.name,
    listModels: () => provider.listModels(),
    ...(provider.listModelInfos ? { listModelInfos: () => provider.listModelInfos!() } : {}),
    async chat(...args) {
      const destination = owner()
      const record = (usage: LLMResponseUsage | null) => store.appendRawEvents(destination.physicalId, [{
        type: 'model_usage', id: randomUUID(), sessionId: destination.sessionId,
        timestamp: new Date().toISOString(), usage,
      }])
      let response
      try { response = await provider.chat(...args) }
      catch (cause) {
        await record(null)
        throw cause
      }
      const usage = parseTokenUsage(response.usage)
      await record(usage)
      if (response.usage !== undefined && !usage) throw new Error('The model returned invalid token usage.')
      return response
    },
  }
}

export async function readTokenUsage(store: SessionStore, state: SessionState) {
  let usage: LLMResponseUsage | null = null
  let legacy: LLMResponseUsage | null = null
  let incomplete = false
  let tracked = false
  const seen = new Set<string>()
  for (let index = 0; index <= state.segmentIndex; index++) {
    for await (const record of store.readSessionLog(physicalSessionId(state, index))) {
      if (record.type === 'model_usage' && record.sessionId === state.sessionId) {
        tracked = true
        if (typeof record.id !== 'string' || seen.has(record.id)) continue
        seen.add(record.id)
        const value = parseTokenUsage(record.usage)
        if (!value) incomplete = true
        usage = addTokenUsage(usage, value)
      } else if (!tracked && record.role === 'assistant') {
        const value = parseTokenUsage(record.usage)
        const context = record.responseContext
        const responseId = context && typeof context === 'object' && 'responseId' in context
          && typeof context.responseId === 'string' ? context.responseId : undefined
        if (value && responseId) {
          if (!seen.has(responseId)) { seen.add(responseId); usage = addTokenUsage(usage, value) }
          continue
        }
        // Historical assistant messages reused context usage and cannot identify
        // distinct calls. Retain one known call, never sum repeated snapshots.
        if (value) { legacy = value; incomplete = true }
      }
    }
  }
  return { usage: addTokenUsage(legacy, usage), incomplete }
}
