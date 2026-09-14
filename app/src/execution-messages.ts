import { isRecord, type SidebarSession } from './projects-sidebar.ts'
import { executionDisplayStage, isExecutionStatus } from './subagent-executions.ts'
import { pairToolResults, parseToolCall, type ToolActivityMessage } from './tool-activity.ts'
import type { SessionStage } from './session-activity.ts'

export interface InlineExecution {
  mode: 'task' | 'call'
  label: string
  agentType?: string
  sessionId?: string
  stage?: SessionStage
  blocked: boolean
  arguments: string
  receipt?: string
  output?: string
  partialWork?: string
}

function receipt(text: string | undefined): Record<string, unknown> | undefined {
  if (!text) return
  try {
    const value: unknown = JSON.parse(text)
    if (isRecord(value) && typeof value.sessionId === 'string' && value.sessionId.trim()
      && ['session', 'task', 'call'].includes(String(value.mode))
      && (isExecutionStatus(value.status) || value.status === 'blocked')) return value
  } catch { /* Legacy errors stay visible as raw tool results. */ }
}

export function inlineExecutionMessages(
  messages: readonly ToolActivityMessage[], sessions: readonly SidebarSession[],
  ownerId: string, stages: Record<string, string>, live: boolean,
): { entries: Map<number, InlineExecution>; excluded: Set<number> } {
  const entries = new Map<number, InlineExecution>()
  const excluded = new Set<number>()
  const pairs = pairToolResults(messages)
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.event !== 'tool_call') continue
    const call = parseToolCall(message)
    if (call.name !== 'subagent') continue
    const resultIndex = pairs.get(index)
    const raw = resultIndex === undefined ? undefined : messages[resultIndex].content
    const result = receipt(raw)
    const candidates = sessions.filter(session => session.parentSessionId === ownerId && (
      typeof result?.sessionId === 'string' ? session.sessionId === result.sessionId
        : !!message.toolCallId && session.parentToolCallId === message.toolCallId))
    const session = candidates.length === 1 ? candidates[0] : undefined
    const mode = result?.mode ?? session?.mode ?? call.args.mode
    if (mode !== 'task' && mode !== 'call') continue
    const status = isExecutionStatus(result?.status) ? result.status : undefined
    const blocked = result?.status === 'blocked'
    const failed = raw !== undefined && (!result || result.status === 'failed' || blocked)
    entries.set(index, {
      mode,
      label: typeof call.args.description === 'string' ? call.args.description : session?.label ?? (mode === 'task' ? 'Delegated task' : 'Context call'),
      agentType: session?.agentType ?? (typeof call.args.agent_type === 'string' ? call.args.agent_type : undefined),
      sessionId: session?.sessionId ?? (typeof result?.sessionId === 'string' && result.sessionId ? result.sessionId : undefined),
      stage: blocked || failed ? 'failed' : session ? executionDisplayStage(session, stages[session.sessionId]) : status ?? (live ? 'running' : undefined),
      blocked,
      arguments: call.raw,
      receipt: raw,
      output: mode === 'call' || failed
        ? typeof result?.error === 'string' ? result.error
          : typeof result?.blockedReason === 'string' ? result.blockedReason
          : typeof result?.result === 'string' ? result.result : raw
        : undefined,
      partialWork: typeof result?.partialWork === 'string' ? result.partialWork : undefined,
    })
    excluded.add(index)
    if (resultIndex !== undefined) excluded.add(resultIndex)
  }
  return { entries, excluded }
}
