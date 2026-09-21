export interface WorkAgreement {
  key: string
  subject: { kind: 'topic'; sessionId: string } | { kind: 'item'; initiativeId: string; itemId: string }
  revision: number
  definition: { objective: string; acceptance: string[]; boundaries: string[]; evidence: unknown[] }
  origin: 'human' | 'agent_interpretation'
  reason: string
  paused: boolean
  authority: { manager: string | null; executor: string | null; active: boolean }
  adoption?: { sessionId: string; revision: number; understanding: string; stop: string[]; retain: string[]; next: string[] }
  checkpoint?: { revision: number; completed: string[]; artifacts: string[]; inFlight: string[]; unknown: string[]; retired: string[] }
  transition?: { status: 'pending' | 'applied'; strategy: 'fresh' | 'successor'; successorId?: string }
  answerReview?: { text: string }
  history: { kind: string; actor: string; at: string; data: unknown }[]
}
export interface WorkView {
  records: WorkAgreement[]
  effects: { id: string; sessionId: string; tool: string; status: string }[]
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function assertWorkView(value: unknown): asserts value is WorkView {
  if (!object(value) || !Array.isArray(value.records) || !Array.isArray(value.effects)) throw new Error('Invalid work alignment response.')
  for (const entry of value.records) {
    if (!object(entry) || typeof entry.key !== 'string' || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1
      || !object(entry.subject) || !(entry.subject.kind === 'topic' && typeof entry.subject.sessionId === 'string'
        || entry.subject.kind === 'item' && typeof entry.subject.initiativeId === 'string' && typeof entry.subject.itemId === 'string')
      || !object(entry.definition) || typeof entry.definition.objective !== 'string' || !strings(entry.definition.acceptance)
      || !strings(entry.definition.boundaries) || !Array.isArray(entry.definition.evidence)
      || !['human', 'agent_interpretation'].includes(String(entry.origin)) || typeof entry.reason !== 'string'
      || typeof entry.paused !== 'boolean' || !object(entry.authority) || typeof entry.authority.active !== 'boolean'
      || ![entry.authority.manager, entry.authority.executor].every(id => id === null || typeof id === 'string')
      || !Array.isArray(entry.history) || entry.history.some(item => !object(item) || typeof item.kind !== 'string'
        || typeof item.actor !== 'string' || typeof item.at !== 'string')) throw new Error('Invalid work agreement.')
    if (entry.adoption !== undefined && (!object(entry.adoption) || typeof entry.adoption.sessionId !== 'string'
      || !Number.isSafeInteger(entry.adoption.revision) || typeof entry.adoption.understanding !== 'string'
      || !strings(entry.adoption.stop) || !strings(entry.adoption.retain) || !strings(entry.adoption.next))) throw new Error('Invalid adoption.')
    const checkpoint = entry.checkpoint
    if (checkpoint !== undefined && (!object(checkpoint) || !Number.isSafeInteger(checkpoint.revision)
      || !['completed', 'artifacts', 'inFlight', 'unknown', 'retired'].every(key => strings(checkpoint[key])))) throw new Error('Invalid checkpoint.')
    if (entry.transition !== undefined && (!object(entry.transition) || !['pending', 'applied'].includes(String(entry.transition.status))
      || !['fresh', 'successor'].includes(String(entry.transition.strategy))
      || (entry.transition.successorId !== undefined && typeof entry.transition.successorId !== 'string'))) throw new Error('Invalid transition.')
    if (entry.answerReview !== undefined && (!object(entry.answerReview) || typeof entry.answerReview.text !== 'string')) throw new Error('Invalid answer review.')
  }
  if (value.effects.some(effect => !object(effect) || !['id', 'sessionId', 'tool', 'status'].every(key => typeof effect[key] === 'string'))) throw new Error('Invalid work effect inventory.')
}
export function parseWorkView(value: unknown): WorkView {
  assertWorkView(value)
  return value
}
