import type { ChatMessage } from '../../providers/provider.ts'

export const SESSION_ITERATION_LIMIT = 1000

export class InferenceBudget {
  private used = 0

  constructor(private readonly limit = SESSION_ITERATION_LIMIT) {
    if (!Number.isSafeInteger(limit) || limit < 1) throw new RangeError('Invalid inference budget')
  }

  get remaining(): number { return this.limit - this.used }

  take(reserve = 0): void {
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new RangeError('Invalid inference reservation')
    if (this.remaining <= reserve) throw new Error('Inference budget exhausted; nested infer must leave one request for the parent.')
    this.used++
  }
}

export function withExecutionBudget(messages: ChatMessage[], remaining: number, scope: 'turn' | 'evaluation', remainingMs?: number): ChatMessage[] {
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new RangeError('Remaining inference requests must be a positive safe integer')
  if (remainingMs !== undefined && (!Number.isFinite(remainingMs) || remainingMs < 0)) throw new RangeError('Remaining time must be finite and nonnegative')
  const boundary = scope === 'turn'
    ? 'this turn; this is not a provider quota or a promise of another turn'
    : 'this entire evaluation, shared across follow-ups and author testing; another turn does not reset it'
  const guidance = `## Remaining execution budget\n${remaining} inference requests including this one remain for ${boundary}.` +
    (remainingMs === undefined ? '' : `\nThe enforced deadline is in ${Math.ceil(remainingMs / 1000)} seconds, including operator waiting. The request count is only an upper bound; expiry may interrupt a request.`) +
    (remaining <= 20 || remainingMs !== undefined && remainingMs <= 5 * 60_000
      ? '\nPrioritize the required outcome and reserve requests for necessary tools and the final result. Report incomplete or blocked work honestly; do not fabricate success or assume more calls.'
      : '')
  return messages[0]?.role === 'system' && typeof messages[0].content === 'string'
    ? messages.map((message, index) => index === 0 ? { ...message, content: `${message.content}\n\n${guidance}` } : message)
    : [{ role: 'system', content: guidance }, ...messages]
}
