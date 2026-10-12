import { t } from './i18n.ts'
import { isRecord } from './folders-sidebar.ts'
import { parseTopicMetadata, type TopicMetadata } from './project-coordination.ts'

export interface SessionDetails {
  sessionId: string
  sessionKind?: 'topic' | 'orchestrator'
  topic?: TopicMetadata
  createdBySessionId?: string
  name: string | null
  description?: string
  workdir: { kind: 'local' | 'remote'; displayPath: string | null; nodeId?: string; nodeName?: string; displayName?: string; available?: boolean }
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
  subagentUsage?: SessionDetails['usage']
  usageIncomplete?: boolean
  usageScope: 'session' | 'segment' | 'latest-call'
  context: { usedTokens: number | null; windowTokens: number | null; handoff?: { enabled: boolean; low: number; high: number; windowTokens: number } }
}

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const invalid = () => new Error(t('Could not read session details. Reopen the menu to retry.'))

function nullableCount(value: unknown): number | null {
  if (value === null) return null
  if (!tokenCount(value)) throw invalid()
  return value
}

function parseUsage(value: unknown): SessionDetails['usage'] {
  if (value === null) return null
  if (!isRecord(value)) throw invalid()
  const { promptTokens, completionTokens, totalTokens } = value
  if (!tokenCount(promptTokens) || !tokenCount(completionTokens) || !tokenCount(totalTokens)) throw invalid()
  return { promptTokens, completionTokens, totalTokens }
}

export function parseSessionDetails(value: unknown, sessionId: string): SessionDetails {
  if (!isRecord(value) || value.sessionId !== sessionId || !nullableString(value.name)
    || !isRecord(value.workdir) || (value.workdir.kind !== 'local' && value.workdir.kind !== 'remote')
    || !nullableString(value.workdir.displayPath) || !isRecord(value.context)
    || (value.usageScope !== 'session' && value.usageScope !== 'segment' && value.usageScope !== 'latest-call')) throw invalid()
  const usedTokens = nullableCount(value.context.usedTokens)
  const windowTokens = nullableCount(value.context.windowTokens)
  const handoff = value.context.handoff
  if (handoff !== undefined && (!isRecord(handoff) || typeof handoff.enabled !== 'boolean'
    || typeof handoff.low !== 'number' || !Number.isFinite(handoff.low) || handoff.low < 0 || handoff.low > 1
    || typeof handoff.high !== 'number' || !Number.isFinite(handoff.high) || handoff.high < 0 || handoff.high > 1
    || !tokenCount(handoff.windowTokens) || handoff.windowTokens === 0)) throw invalid()
  for (const key of ['nodeId', 'nodeName', 'displayName']) {
    if (value.workdir[key] !== undefined && typeof value.workdir[key] !== 'string') throw invalid()
  }
  if (value.workdir.available !== undefined && typeof value.workdir.available !== 'boolean') throw invalid()
  if (windowTokens === 0) throw invalid()
  if (value.sessionKind !== undefined && value.sessionKind !== 'topic' && value.sessionKind !== 'orchestrator') throw invalid()
  if (value.createdBySessionId !== undefined && typeof value.createdBySessionId !== 'string') throw invalid()
  if (value.description !== undefined && typeof value.description !== 'string') throw invalid()
  if (value.usageIncomplete !== undefined && typeof value.usageIncomplete !== 'boolean') throw invalid()
  return {
    sessionId,
    ...(value.sessionKind !== undefined ? { sessionKind: value.sessionKind as SessionDetails['sessionKind'] } : {}),
    ...(value.topic !== undefined ? { topic: parseTopicMetadata(value.topic) } : {}),
    ...(typeof value.createdBySessionId === 'string' ? { createdBySessionId: value.createdBySessionId } : {}),
    name: value.name,
    ...(typeof value.description === 'string' ? { description: value.description } : {}),
    workdir: { kind: value.workdir.kind === 'remote' ? 'remote' : 'local', displayPath: value.workdir.displayPath,
      ...(typeof value.workdir.nodeId === 'string' ? { nodeId: value.workdir.nodeId } : {}),
      ...(typeof value.workdir.nodeName === 'string' ? { nodeName: value.workdir.nodeName } : {}),
      ...(typeof value.workdir.displayName === 'string' ? { displayName: value.workdir.displayName } : {}),
      ...(typeof value.workdir.available === 'boolean' ? { available: value.workdir.available } : {}) },
    usage: parseUsage(value.usage),
    ...(value.subagentUsage !== undefined ? { subagentUsage: parseUsage(value.subagentUsage) } : {}),
    ...(value.usageIncomplete !== undefined ? { usageIncomplete: value.usageIncomplete } : {}),
    usageScope: value.usageScope === 'session' ? 'session' : value.usageScope === 'segment' ? 'segment' : 'latest-call',
    context: { usedTokens, windowTokens, ...(handoff !== undefined ? { handoff: handoff as NonNullable<SessionDetails['context']['handoff']> } : {}) },
  }
}

const tokenFormatter = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

export function formatTokenCount(value: number): string {
  return tokenFormatter.format(value)
}

export function contextPercent(context: SessionDetails['context']): number | null {
  return context.usedTokens === null || context.windowTokens === null
    ? null : Math.round(context.usedTokens / context.windowTokens * 1000) / 10
}

/** Unknown usage is not free capacity. Clip geometry, not the reported counts. */
export function contextCapacity(context: SessionDetails['context']) {
  const { usedTokens: used, windowTokens: window, handoff } = context
  return {
    usedPercent: used === null || window === null ? null : Math.min(100, used / window * 100),
    remainingTokens: used === null || window === null ? null : Math.max(0, window - used),
    overflowTokens: used === null || window === null ? null : Math.max(0, used - window),
    markers: handoff && window !== null ? (['low', 'high'] as const).map(kind => ({
      kind, ratio: handoff[kind], tokens: Math.round(handoff[kind] * handoff.windowTokens),
      percent: Math.min(100, handoff[kind] * handoff.windowTokens / window * 100),
    })) : [],
  }
}
