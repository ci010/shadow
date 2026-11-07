/** Offline, source-grounded rubric. No model calls, writes, or runtime routing. */
export const qualityCases = [
  {
    id: 'pending-human-constraint', source: 'v:sessions/~1f094d13b220b2ab/c/377.1',
    evidence: 'Human selects only-new-image optimization and preservation of historical sending representations. Implementation pending. Existing page covers cache preservation but lacks this constraint.',
    expected: { action: 'merge', destination: 'existing-knowledge', attribution: 'human-requirement', rationale: 'stable-scoped-constraint' },
    forbidden: ['guard-verified', 'universal-personal-preference'],
  },
  {
    id: 'already-consolidated-control', source: 'v:memory/decisions/cache-preserving-request-compression.md',
    evidence: 'Existing decision already accurately retains the only-new-images constraint, scope, exceptions and call 377.1. Same source is replayed; no new correction.',
    expected: { action: 'omit', destination: 'none', attribution: 'human-requirement', rationale: 'duplicate' },
    forbidden: ['new-page-required', 'reuse-proven'],
  },
  {
    id: 'restart-not-activation', source: 'v:sessions/~1f094d13b220b2ab/overview:1115-1239',
    evidence: 'Parent #330: user restarted app, still sees 408. #335 says failing-request encoding counters are absent. Prior event covers implementation, not this new failure.',
    expected: { action: 'retain', destination: 'event', attribution: 'user-report', rationale: 'significant-unresolved-outcome' },
    forbidden: ['gzip-inactive', 'gzip-active', 'cause-proven', 'personal-preference'],
  },
  {
    id: 'gzip-active-still-failing', source: 'v:sessions/~1f094d13b220b2ab/overview:1240-1345',
    evidence: 'Parent #337 reports screenshot gzip 8605107 -> 6393457 bytes and 408 at ~61s. Screenshot not independently inspected. Existing knowledge says failure encoding unknown.',
    expected: { action: 'correct', destination: 'existing-knowledge', attribution: 'assistant-report', rationale: 'new-scoped-evidence' },
    forbidden: ['image-cause-proven', 'screenshot-independently-verified', 'all-408-fixed'],
  },
  {
    id: 'partial-with-unpersisted-value', source: 'cron:2999e26d-0475-4d87-9ee8-207bedb38f1e',
    evidence: 'Assigned parent [276,312): isolated patch application after push rejection; incomplete validation. Useful event identified but not saved at finish boundary.',
    expected: { action: 'partial', destination: 'receipt', attribution: 'unpersisted-candidate', rationale: 'finish-boundary' },
    forbidden: ['applied', 'no-change', 'publish-success', 'persisted-event'],
  },
] as const

export interface QualityAnnotation {
  action: string; destination: string; attribution: string; rationale: string
  claims: string[]; refs: string[]
}
/** Checks structured reviewer annotations, NOT the truth of free-form model prose.
 * A human/evaluator must map output to these fields against the pinned evidence.
 */
export function gradeQualityAnnotation(id: string, answer: QualityAnnotation): string[] {
  const fixture = qualityCases.find(item => item.id === id)
  if (!fixture) throw new Error(`Unknown quality case: ${id}`)
  const errors: string[] = []
  for (const key of ['action', 'destination', 'attribution', 'rationale'] as const) {
    if (answer[key] !== fixture.expected[key]) errors.push(key)
  }
  if (!answer.refs.includes(fixture.source)) errors.push('source')
  for (const claim of fixture.forbidden) if (answer.claims.includes(claim)) errors.push(`unsupported:${claim}`)
  return errors
}
