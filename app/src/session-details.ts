import { t, formatNumber } from './i18n.ts'
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
  usageScope: 'session' | 'segment' | 'latest-call'
  context: { usedTokens: number | null; windowTokens: number | null }
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
  for (const key of ['nodeId', 'nodeName', 'displayName']) {
    if (value.workdir[key] !== undefined && typeof value.workdir[key] !== 'string') throw invalid()
  }
  if (value.workdir.available !== undefined && typeof value.workdir.available !== 'boolean') throw invalid()
  if (windowTokens === 0) throw invalid()
  if (value.sessionKind !== undefined && value.sessionKind !== 'topic' && value.sessionKind !== 'orchestrator') throw invalid()
  if (value.createdBySessionId !== undefined && typeof value.createdBySessionId !== 'string') throw invalid()
  if (value.description !== undefined && typeof value.description !== 'string') throw invalid()
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
    usageScope: value.usageScope === 'session' ? 'session' : value.usageScope === 'segment' ? 'segment' : 'latest-call',
    context: { usedTokens, windowTokens },
  }
}

export function formatTokenCount(value: number): string {
  return formatNumber(value, { notation: 'compact', maximumFractionDigits: 1 })
}

export function contextPercent(context: SessionDetails['context']): number | null {
  return context.usedTokens === null || context.windowTokens === null
    ? null : Math.round(context.usedTokens / context.windowTokens * 1000) / 10
}
