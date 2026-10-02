import type { ChatMessage } from '../../providers/provider.ts'

export const SESSION_ITERATION_LIMIT = 100

export function withExecutionBudget(messages: ChatMessage[], remaining: number, scope: 'turn' | 'evaluation', remainingMs?: number): ChatMessage[] {
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new RangeError('Remaining inference requests must be a positive safe integer')
  if (remainingMs !== undefined && (!Number.isFinite(remainingMs) || remainingMs < 0)) throw new RangeError('Remaining time must be finite and nonnegative')
  const boundary = scope === 'turn'
    ? 'this turn; this is not a provider quota or a promise of another turn'
    : 'this entire evaluation, shared across follow-ups and author testing; another turn does not reset it'
  const guidance = `## Remaining execution budget\n${remaining} inference requests including this one remain for ${boundary}.` +
    (remainingMs === undefined ? '' : `\nThe enforced deadline is in ${Math.ceil(remainingMs / 1000)} seconds, including operator waiting. The request count is only an upper bound; expiry may interrupt a request.`) +
    (remaining <= 20 || remainingMs !== undefined && remainingMs <= 5 * 60_000
      ? '\nPrioritize a reviewable deliverable and the acceptance record over optional polish. Reserve calls for publication and, only after approval, runtime testing and reporting. Save incomplete/blocked checks honestly; do not bypass review, fabricate passes or assume more calls.'
      : '')
  return messages[0]?.role === 'system' && typeof messages[0].content === 'string'
    ? messages.map((message, index) => index === 0 ? { ...message, content: `${message.content}\n\n${guidance}` } : message)
    : [{ role: 'system', content: guidance }, ...messages]
}
