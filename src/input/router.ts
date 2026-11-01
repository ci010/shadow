/** External input, not the runtime/memory event bus or a persistent queue.
 * Only trusted host entrypoints assign source identities. Payload cannot confer
 * human/admin authority, install a producer, or grant delivery permission.
 */
export interface InputSource { type: string; id: string }
export interface InputRoute {
  source: InputSource
  kind: string
  topic: string
}
export interface InputEnvelope<T, Reply = unknown> extends InputRoute {
  projectId: string
  id: string
  correlationId?: string
  /** Correlation metadata only: this in-process router promises no deduplication. */
  deduplicationKey?: string
  /** Entry-verified ancestry, never inferred from user content. */
  parents?: readonly string[]
  reply?: Reply
  payload: T
}
export type InputTarget = { kind: 'bot' | 'session'; id: string }
export interface InputListener extends InputRoute {
  descendants?: boolean
  target: InputTarget
}
export function matchesInput(selector: InputListener, input: InputRoute & { parents?: readonly string[] }): boolean {
  return selector.source.type === input.source.type && selector.source.id === input.source.id && selector.kind === input.kind &&
    (selector.topic === input.topic || selector.descendants === true && !!input.parents?.includes(selector.topic))
}

/** Single-owner delivery. No business filters, inference, fanout or Agent fallback.
 * Listeners are a live projection of host state, never installed by an input.
 * Arbitrary sources (including controlled program signals) use the same envelope;
 * connectors and producer grants are owned by their host entrypoints, not this class.
 */
export class InputRouter<T, R> {
  constructor(readonly projectId: string, private readonly options: {
    listeners: () => readonly InputListener[]
    deliver: (target: InputTarget, input: InputEnvelope<T>) => Promise<R>
  }) {}

  async route(input: InputEnvelope<T>): Promise<R | undefined> {
    if (input.projectId !== this.projectId) throw new Error('External input Project mismatch')
    const matches = this.options.listeners().filter(sub => matchesInput(sub, input))
    const targets = new Map(matches.map(sub => [JSON.stringify([sub.target.kind, sub.target.id]), sub.target]))
    if (targets.size > 1) throw new Error('External input has conflicting subscribers')
    const target = targets.values().next().value
    return target ? this.options.deliver(target, input) : undefined
  }
}
