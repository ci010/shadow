interface DeliveryTimelineMessage {
  requestId?: string
  delivery?: string
}

/** A scheduling snapshot can overlap saved history before provider dispatch.
 * Prefer the scheduling entry until Main dispatches the input and drops it.
 * Local submissions without a receipt have no authoritative ID to reconcile.
 */
export function mergeInputDelivery<T extends DeliveryTimelineMessage>(
  history: T[], snapshot: T[] | undefined, previous: T[],
): T[] {
  const local = previous.filter(message => message.delivery && !message.requestId)
  const pending = snapshot ?? previous.filter(message => message.delivery && message.requestId)
  const pendingIds = new Set(pending.flatMap(message => message.requestId ? [message.requestId] : []))
  return [...history.filter(message => !message.requestId || !pendingIds.has(message.requestId)), ...pending, ...local]
}
