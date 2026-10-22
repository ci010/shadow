import type { DecisionBrief } from '../sessions/decision-brief.ts'

export const decisionBrief: DecisionBrief = {
  goal: 'Complete the requested evaluation within its existing scope.',
  whyHuman: 'The proposed change would expand the agreed scope.',
  recommendation: 'Preserve the existing scope until the uncertainty is resolved.',
  tradeoff: 'Expansion may add cost; investigation delays only the dependent work.',
  blocked: ['Changing the evaluation scope'],
  unaffected: ['Reading existing pipeline documentation'],
  claims: [{ kind: 'assumption', text: 'The current entry point may not cover the requested evaluation; this needs checking.' }],
}
