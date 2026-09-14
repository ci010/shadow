import { isRecord } from './projects-sidebar.ts'

export interface SessionDetails {
  sessionId: string
  name: string | null
  workdir: { kind: 'local' | 'remote'; displayPath: string | null }
  usage: { promptTokens: number; completionTokens: number; totalTokens: number } | null
  usageScope: 'session' | 'segment' | 'latest-call'
  context: { usedTokens: number | null; windowTokens: number | null }
}

const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
const nullableString = (value: unknown): value is string | null => value === null || typeof value === 'string'
const invalid = () => new Error('Could not read session details. Reopen the menu to retry.')

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
  if (windowTokens === 0) throw invalid()
  return {
    sessionId,
    name: value.name,
    workdir: { kind: value.workdir.kind === 'remote' ? 'remote' : 'local', displayPath: value.workdir.displayPath },
    usage: parseUsage(value.usage),
    usageScope: value.usageScope === 'session' ? 'session' : value.usageScope === 'segment' ? 'segment' : 'latest-call',
    context: { usedTokens, windowTokens },
  }
}

const compact = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 })
export function formatTokenCount(value: number): string {
  return compact.format(value)
}

export function contextPercent(context: SessionDetails['context']): number | null {
  return context.usedTokens === null || context.windowTokens === null
    ? null : Math.round(context.usedTokens / context.windowTokens * 1000) / 10
}
