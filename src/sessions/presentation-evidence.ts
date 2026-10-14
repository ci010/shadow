import type { SessionState, SessionStore } from './session-store.ts'
import { hasTruncatedLegacyHistory, physicalSessionId } from './session-identity.ts'
import type { PresentationSource } from '../projects/presentation-contract.ts'

/** Own physical segments only, never inherited forks, reasoning, tool traces or child logs.
 * Record offsets count ALL raw records, preserving exact JSONL/SQLite provenance.
 * Legacy untagged user records are omitted rather than promoted to human authority.
 */
export async function readPresentationEvidence(store: Pick<SessionStore, 'readSessionLog'>, state: SessionState,
  signal: AbortSignal): Promise<{ sources: PresentationSource[]; partial: boolean }> {
  if (state.parentSessionId || state.channelBoundary || state.automation || hasTruncatedLegacyHistory(state)) return { sources: [], partial: true }
  const selected: PresentationSource[] = []
  let partial = state.segmentIndex >= 8, scanned = 0
  const first = Math.max(0, state.segmentIndex - 7)
  for (let segment = first; segment <= state.segmentIndex; segment++) {
    const physicalId = physicalSessionId(state, segment)
    let index = 0
    for await (const record of store.readSessionLog(physicalId)) {
      signal.throwIfAborted()
      const id = `record:${index++}`
      if (++scanned > 20000) { partial = true; break }
      if (record.name && String(record.name).startsWith('__')) continue
      let kind: PresentationSource['kind'] | undefined
      let text = ''
      if (record.role === 'user') {
        const content = record.content
        // Only a separate runtime-written human sender envelope establishes participation.
        if (!Array.isArray(content) || content[0]?.type !== 'text') continue
        const envelope = String(content[0].text ?? '')
        if (!/^<sender\s[^>]*\/>$/.test(envelope)) continue
        if (/\ssource="session"/.test(envelope)) kind = 'report'
        else if (/\schat="(?:direct|group)"/.test(envelope)) kind = 'human'
        else continue
        text = content.slice(1).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n')
      } else if (record.role === 'assistant' && !(Array.isArray(record.tool_calls) && record.tool_calls.length)) {
        const context = record.responseContext as { userInvolved?: boolean } | undefined
        // Runtime-tagged parent responses can contain material autonomous choices.
        // They remain model evidence, never human direction or acceptance.
        if (typeof context?.userInvolved !== 'boolean') continue
        kind = 'assistant'
        text = typeof record.content === 'string' ? record.content : ''
      }
      if (!kind || !text.trim()) continue
      if (text.length > 4000) partial = true
      selected.push({ sessionId: state.sessionId, physicalId, id, kind, text: text.slice(0, 4000),
        ...(typeof record.timestamp === 'string' ? { at: record.timestamp } : {}) })
      if (selected.length > 80) { selected.splice(1, 1); partial = true }
    }
    if (scanned > 20000) break
  }
  return { sources: selected, partial }
}
