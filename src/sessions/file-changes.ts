import type { SessionState, SessionStore } from './session-store.ts'
import { physicalSessionId } from './session-identity.ts'
import { fileChangeSchema, type FileChangesPage, type RecordedFileChange } from './file-change-contract.ts'
import { recordedFileChange } from '../tools/file-change.ts'

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : Array.isArray(value)
    ? value.filter(part => record(part) && part.type === 'text' && typeof part.text === 'string').map(part => part.text).join('\n') : ''
}
function writeCall(value: unknown): Record<string, unknown> | undefined {
  if (!record(value) || !record(value.function) || typeof value.function.arguments !== 'string') return
  let args: unknown
  try { args = JSON.parse(value.function.arguments) }
  catch { return }
  if (!record(args)) return
  if (value.function.name === 'invoke_tool' && args.name === 'write' && record(args.args)) return args.args
  return value.function.name === 'write' ? args : undefined
}

type WriteEvidence = { change: RecordedFileChange } | {
  args: Record<string, unknown> & { path: string; content: string }; toolCallId: string; segment: number
  mode: RecordedFileChange['mode']; timestamp?: string
}

/** Own physical segments only: forked context is not evidence of writes by this session. */
async function* writeEvidence(
  store: Pick<SessionStore, 'readSessionLog'>, state: SessionState, signal: AbortSignal,
): AsyncGenerator<WriteEvidence> {
  for (let segment = 0; segment <= state.segmentIndex; segment++) {
    signal.throwIfAborted()
    const calls = new Map<string, Record<string, unknown>>()
    const observed = new Set<string>()
    for await (const event of store.readSessionLog(physicalSessionId(state, segment))) {
      signal.throwIfAborted()
      if (event.file_change !== undefined) {
        const change = fileChangeSchema.parse(event.file_change)
        if (change.sessionId !== state.sessionId) throw new Error('Recorded file change belongs to another session.')
        yield { change }
        if (calls.has(change.toolCallId)) observed.add(change.toolCallId)
      }
      if (event.role === 'assistant' && Array.isArray(event.tool_calls)) {
        for (const call of event.tool_calls) {
          const args = writeCall(call)
          if (args && record(call) && typeof call.id === 'string') calls.set(call.id, args)
        }
      }
      if (event.role !== 'tool' || typeof event.tool_call_id !== 'string') continue
      const args = calls.get(event.tool_call_id)
      calls.delete(event.tool_call_id)
      if (observed.delete(event.tool_call_id)) continue
      const result = text(event.content)
      if (!args || typeof args.path !== 'string' || typeof args.content !== 'string'
        || !/^Success: (write|edit|append) /.test(result)) continue
      const mode = result.startsWith('Success: edit ') ? 'edit' : result.startsWith('Success: append ') ? 'append' : 'write'
      const timestamp = typeof event.timestamp === 'string' ? event.timestamp : undefined
      yield { args: { ...args, path: args.path, content: args.content }, toolCallId: event.tool_call_id, segment, mode, timestamp }
    }
  }
}

export async function readSessionFileChanges(
  store: Pick<SessionStore, 'readSessionLog'>, state: SessionState, offset: number, limit: number, signal: AbortSignal,
): Promise<FileChangesPage> {
  const snapshot = { ...state }
  let total = 0
  // Count without retaining previews or computing legacy diffs for unrequested pages.
  for await (const _evidence of writeEvidence(store, snapshot, signal)) total++
  const end = Math.max(0, total - offset)
  const start = Math.max(0, end - limit)
  const changes: RecordedFileChange[] = []
  if (end > 0) {
    let index = 0
    for await (const evidence of writeEvidence(store, snapshot, signal)) {
      if (index++ < start) continue
      if ('change' in evidence) changes.push(evidence.change)
      else {
        const { args, mode, timestamp } = evidence
        const legacy = recordedFileChange({
          sessionId: snapshot.sessionId, toolCallId: evidence.toolCallId, timestamp, path: args.path, mode,
          before: mode === 'edit' && typeof args.match === 'string' ? args.match : undefined,
          after: args.content, scope: mode === 'edit' ? 'requested-edit' : 'written-content',
          unavailable: 'This older write did not record the previous file content. A complete file diff is unavailable.',
        })
        legacy.id = `legacy:${evidence.segment}:${evidence.toolCallId}`
        legacy.timestamp = timestamp
        changes.push(legacy)
      }
      if (index >= end) break
    }
  }
  return { changes: changes.reverse(), total, offset }
}
