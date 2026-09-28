import { z } from 'zod'

export interface DecisionEvidence {
  sessionId: string
  physicalId: string
  kind: 'user' | 'tool'
  id: string
  quote: string
}

export const DECISION_EVIDENCE_HELP = {
  sessionId: 'source session ID',
  physicalId: 'source physical segment ID',
  kind: 'user | tool',
  id: 'recorded input ID or tool call ID',
  quote: 'Exact source excerpt, not a summary. Reuse a returned reference when available.',
}

export const decisionEvidenceSchema = z.object({
  sessionId: z.string().max(512).trim().min(1),
  physicalId: z.string().max(512).trim().min(1),
  kind: z.enum(['user', 'tool']),
  id: z.string().max(512).trim().min(1),
  quote: z.string().max(2000).trim().min(1),
}).strict()

export interface DecisionBrief {
  goal: string
  whyHuman: string
  recommendation: string
  tradeoff: string
  blocked: string[]
  unaffected: string[]
  claims: {
    kind: 'user_constraint' | 'observation' | 'assumption' | 'proposal'
    text: string
    evidence?: DecisionEvidence
  }[]
}

export const DECISION_BRIEF_HELP = {
  goal: 'Original outcome in plain language.',
  whyHuman: 'Why does the recipient need to decide the goal, acceptance, budget, permission or material risk? A parent may resolve within existing authority; it cannot replace human approval.',
  recommendation: 'Recommended option and why.',
  tradeoff: 'How alternatives affect the goal, cost and uncertainty.',
  blocked: ['Work that must not proceed without this decision (1-6 entries).'],
  unaffected: ['Independent work still within existing authorization (0-6 entries).'],
  claims: [{ kind: 'user_constraint | observation | assumption | proposal', text: 'One claim (at most 8 claims). Constraints and observations need evidence; a user_constraint must equal its user quote, not a paraphrase.',
    evidence: DECISION_EVIDENCE_HELP }],
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Decision brief requires an object.')
  return value as Record<string, unknown>
}
function text(value: unknown, max = 2000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new TypeError(`Decision text must contain 1-${max} characters.`)
  return value.trim()
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError('Unknown decision brief field.')
}
function list(value: unknown, min: number): string[] {
  if (!Array.isArray(value) || value.length < min || value.length > 6) throw new TypeError('Decision work scope requires a bounded list.')
  return Array.from(value, item => text(item, 500))
}

export function parseDecisionEvidence(value: unknown, path = 'evidence'): DecisionEvidence {
  const parsed = decisionEvidenceSchema.safeParse(value)
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${[path, ...issue.path].join('.')}: ${issue.message}`).join('; ')
    throw new TypeError(`${details}. Expected an evidence reference {sessionId, physicalId, kind: "user" | "tool", id, quote}; not a decision brief or a prose summary.`)
  }
  return parsed.data
}

export function parseDecisionBrief(value: unknown): DecisionBrief {
  const entry = object(value)
  keys(entry, ['goal', 'whyHuman', 'recommendation', 'tradeoff', 'blocked', 'unaffected', 'claims'])
  if (!Array.isArray(entry.claims) || !entry.claims.length || entry.claims.length > 8) throw new TypeError('A brief requires 1-8 attributed claims.')
  const claims = Array.from(entry.claims, (value): DecisionBrief['claims'][number] => {
    const claim = object(value)
    keys(claim, ['kind', 'text', 'evidence'])
    if (claim.kind !== 'user_constraint' && claim.kind !== 'observation' && claim.kind !== 'assumption' && claim.kind !== 'proposal') {
      throw new TypeError('Separate user constraints, observations, assumptions and proposals.')
    }
    const evidence = claim.evidence === undefined ? undefined : parseDecisionEvidence(claim.evidence)
    const content = text(claim.text)
    if ((claim.kind === 'user_constraint' || claim.kind === 'observation') && !evidence) throw new TypeError('Constraints and observations require source evidence; otherwise label an assumption.')
    if (claim.kind === 'user_constraint' && (evidence?.kind !== 'user' || evidence.quote !== content)) {
      throw new TypeError('A user constraint must quote a recorded human input exactly, not an agent recommendation.')
    }
    return { kind: claim.kind, text: content, ...(evidence ? { evidence } : {}) }
  })
  return { goal: text(entry.goal), whyHuman: text(entry.whyHuman), recommendation: text(entry.recommendation),
    tradeoff: text(entry.tradeoff), blocked: list(entry.blocked, 1), unaffected: list(entry.unaffected, 0), claims }
}
