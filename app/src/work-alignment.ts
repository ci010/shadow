import { t } from './i18n.ts'
import { workWorkflowSchema, workProposalSchema, type WorkRecord, type WorkSubject } from '../../src/initiatives/work-contract.ts'

export interface WorkAgreement {
  key: string
  subject: WorkSubject
  sequence?: number
  workflow?: WorkRecord['workflow']
  proposals?: WorkRecord['proposals']
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
  selected?: string
  records: WorkAgreement[]
  effects: { id: string; sessionId: string; tool: string; status: string }[]
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(item => typeof item === 'string') }
function assertWorkView(value: unknown): asserts value is WorkView {
  if (!object(value) || !Array.isArray(value.records) || !Array.isArray(value.effects)) throw new Error(t('Invalid work alignment response.'))
  for (const entry of value.records) {
    if (!object(entry) || typeof entry.key !== 'string' || !Number.isSafeInteger(entry.revision) || Number(entry.revision) < 1
      || !object(entry.subject) || !(entry.subject.kind === 'work' && typeof entry.subject.id === 'string'
        || entry.subject.kind === 'initiative' && typeof entry.subject.initiativeId === 'string'
        || entry.subject.kind === 'topic' && typeof entry.subject.sessionId === 'string'
        || entry.subject.kind === 'item' && typeof entry.subject.initiativeId === 'string' && typeof entry.subject.itemId === 'string')
      || !object(entry.definition) || typeof entry.definition.objective !== 'string' || !strings(entry.definition.acceptance)
      || !strings(entry.definition.boundaries) || !Array.isArray(entry.definition.evidence)
      || !['human', 'agent_interpretation'].includes(String(entry.origin)) || typeof entry.reason !== 'string'
      || typeof entry.paused !== 'boolean' || !object(entry.authority) || typeof entry.authority.active !== 'boolean'
      || ![entry.authority.manager, entry.authority.executor].every(id => id === null || typeof id === 'string')
      || !Array.isArray(entry.history) || entry.history.some(item => !object(item) || typeof item.kind !== 'string'
        || typeof item.actor !== 'string' || typeof item.at !== 'string')) throw new Error(t('Invalid work agreement.'))
    if (entry.sequence !== undefined && (!Number.isSafeInteger(entry.sequence) || Number(entry.sequence) < 1)) throw new Error(t('Invalid work sequence.'))
    if (entry.workflow !== undefined && !workWorkflowSchema.safeParse(entry.workflow).success) throw new Error(t('Invalid work progress or assignment.'))
    if (entry.proposals !== undefined && (!Array.isArray(entry.proposals) || entry.proposals.some(proposal => !workProposalSchema.safeParse(proposal).success))) throw new Error(t('Invalid work proposal.'))
    if (entry.adoption !== undefined && (!object(entry.adoption) || typeof entry.adoption.sessionId !== 'string'
      || !Number.isSafeInteger(entry.adoption.revision) || typeof entry.adoption.understanding !== 'string'
      || !strings(entry.adoption.stop) || !strings(entry.adoption.retain) || !strings(entry.adoption.next))) throw new Error(t('Invalid adoption.'))
    const checkpoint = entry.checkpoint
    if (checkpoint !== undefined && (!object(checkpoint) || !Number.isSafeInteger(checkpoint.revision)
      || !['completed', 'artifacts', 'inFlight', 'unknown', 'retired'].every(key => strings(checkpoint[key])))) throw new Error(t('Invalid checkpoint.'))
    if (entry.transition !== undefined && (!object(entry.transition) || !['pending', 'applied'].includes(String(entry.transition.status))
      || !['fresh', 'successor'].includes(String(entry.transition.strategy))
      || (entry.transition.successorId !== undefined && typeof entry.transition.successorId !== 'string'))) throw new Error(t('Invalid transition.'))
    if (entry.answerReview !== undefined && (!object(entry.answerReview) || typeof entry.answerReview.text !== 'string')) throw new Error(t('Invalid answer review.'))
  }
  if (value.effects.some(effect => !object(effect) || !['id', 'sessionId', 'tool', 'status'].every(key => typeof effect[key] === 'string'))) throw new Error(t('Invalid work effect inventory.'))
}
export function parseWorkView(value: unknown): WorkView {
  assertWorkView(value)
  return value
}
