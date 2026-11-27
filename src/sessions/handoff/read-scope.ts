import { shortPhysicalReference } from '../history-view.ts'
import { physicalSessionId } from '../session-identity.ts'
import type { SessionState } from '../session-store.ts'
import type { CompactReadArgs } from './draft-runner.ts'

export function scopeCompactRead(args: CompactReadArgs, state: SessionState, scoped: boolean):
  { index: string } | { args: CompactReadArgs; virtual: boolean } {
  const path = args.path.replace(/\\/g, '/')
  if (path !== path.trim() || /[\0\r\n]/.test(path) || path.startsWith('//') ||
    /^[a-z][a-z0-9+.-]*:\/\//i.test(path)) throw new Error('Compact can read files and virtual paths, not network URLs or shares.')
  // ReadTool can also resolve absolute/leading-slash VFS aliases. Check the
  // canonical path before delegating, rather than allowing a history bypass.
  const virtual = /^v:/i.test(path)
  if (!virtual && /(?:^|\/)v:/i.test(path)) throw new Error('Use a canonical virtual path beginning with v:.')
  if (!virtual) return { args, virtual }
  if (/^v:handoff(?:\/|$)/i.test(path)) throw new Error('Use the exact draft path v:handoff/draft.md.')
  if (!/^v:sessions(?:\/|$)/i.test(path)) return { args, virtual }
  const entry = path.slice('v:sessions'.length).replace(/^\//, '')
  if (!entry) {
    if (scoped) return { index: 'This conversation: v:sessions/current' }
    const start = args.offset ?? 1
    const count = state.segmentIndex + 1
    const end = Math.min(count, start + (args.limit ?? 80) - 1)
    const lines: string[] = []
    for (let item = start; item <= end; item++) lines.push(`v:sessions/${physicalSessionId(state, count - item)}`)
    return { index: `Own physical segments, newest first (${count} total):\n${lines.join('\n') || '(no entries on this page)'}` +
      (end < count ? `\n[Use offset=${end + 1} for older segments.]` : '') }
  }
  if (entry === 'current') return { args: { ...args, path: scoped ? 'v:sessions/current' : `v:sessions/${physicalSessionId(state)}` }, virtual }
  // The scoped registry has its own audience and history policy; never turn a
  // scoped current-history read into a Project full-history read.
  if (!scoped && (entry === state.sessionId || entry === `${state.sessionId}/overview` || entry === `${state.sessionId}/full`)) {
    return { args: { ...args, path: `v:sessions/${entry}` }, virtual }
  }
  if (!scoped) {
    const match = /^([^/?#%]+)(?:\/(?:overview|full|(?:calls|c)\/[^/?#]+))?$/.exec(entry)
    if (match) {
      for (let index = state.segmentIndex; index >= 0; index--) {
        const physical = physicalSessionId(state, index)
        if (match[1] === physical || match[1] === shortPhysicalReference(physical)) {
          return { args: { ...args, path: `v:sessions/${physical}${entry.slice(match[1].length)}` }, virtual }
        }
      }
    }
  }
  throw new Error('Compact can only read this session’s history. Read v:sessions for its available paths.')
}
