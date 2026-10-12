import type { SessionConfig } from './session-store.ts'
import { isReasoningEffort, isContextWindow } from '../agent/llm-config.ts'
import { parseYieldPolicy } from './yield-contract.ts'

export interface SessionConfigPatch {
  set: Partial<SessionConfig>
  unset: Array<'model' | 'thinking' | 'reasoningEffort' | 'yield' | 'contextWindow'>
}

export function isConfigObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseSessionConfigPatch(
  value: unknown,
  allowModel = false,
): SessionConfigPatch {
  if (!isConfigObject(value)) throw new TypeError('invalid_config')
  const patch: SessionConfigPatch = { set: {}, unset: [] }
  for (const [key, item] of Object.entries(value)) {
    if (key !== 'thinking' && key !== 'reasoningEffort' && key !== 'model' && key !== 'yield' && key !== 'contextWindow') {
      throw new TypeError('invalid_config_key')
    }
    if (key === 'model' && !allowModel) throw new TypeError('invalid_config_key')
    if (item === null) {
      patch.unset.push(key)
    } else if (key === 'contextWindow') {
      if (!isContextWindow(item)) throw new TypeError('invalid_contextWindow')
      patch.set.contextWindow = item
    } else if (key === 'yield') {
      patch.set.yield = parseYieldPolicy(item)
    } else if (key === 'model') {
      if (typeof item !== 'string' || !item.trim()) throw new TypeError('invalid_model')
      patch.set.model = item
    } else if (key === 'reasoningEffort') {
      if (!isReasoningEffort(item)) throw new TypeError('invalid_reasoningEffort')
      patch.set.reasoningEffort = item
    } else {
      if (!isConfigObject(item) || Object.keys(item).length !== 1 ||
          (item.type !== 'enabled' && item.type !== 'disabled')) {
        throw new TypeError('invalid_thinking')
      }
      patch.set.thinking = { type: item.type }
    }
  }
  return patch
}
