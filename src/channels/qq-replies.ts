/** Conservative ordinary GROUP/C2C passive replies; not the C2C streaming API. */
const WINDOW_MS = 5 * 60_000
const MAX_SOURCES = 500

export type QQFailureKind = 'expired' | 'quota' | 'duplicate' | 'invalid_source' | 'rate' | 'permission' | 'unknown'

const ERROR_KINDS: Readonly<Record<number, QQFailureKind>> = {
  304103: 'expired', 40034005: 'expired', 40034128: 'quota',
  40054005: 'duplicate', 40034024: 'invalid_source',
  40034100: 'rate', 40034105: 'permission',
}

export class QQDeliveryError extends Error {
  constructor(
    readonly kind: QQFailureKind,
    readonly outcome: 'rejected' | 'unknown',
    readonly status?: number,
    readonly code?: number,
  ) {
    super(`QQ delivery failed: ${kind} (${outcome})${status === undefined ? '' : ` status=${status}`}${code === undefined ? '' : ` code=${code}`}`)
    this.name = 'QQDeliveryError'
  }
}

/** Never retain response text, arbitrary error strings, URLs or trace headers. */
export async function qqResponseError(response: Response): Promise<QQDeliveryError> {
  const data: unknown = await response.json().catch(() => undefined)
  const raw = data && typeof data === 'object' && 'code' in data ? data.code : undefined
  const code = typeof raw === 'number' ? raw
    : typeof raw === 'string' && /^\d{1,8}$/.test(raw) ? Number(raw) : undefined
  const kind = code === undefined ? undefined : ERROR_KINDS[code]
  return new QQDeliveryError(kind ?? 'unknown', kind ? 'rejected' : 'unknown', response.status, kind ? code : undefined)
}

interface Source {
  deadline: number
  limit: number
  used: number
  accepted: boolean
  ready: Promise<void>
  settle: () => void
  tail: Promise<unknown>
  blocked: boolean
}

export class QQPassiveReplies {
  private sources = new Map<string, Source>()
  private epoch = Date.now()

  clear(): void {
    for (const source of this.sources.values()) source.settle()
    this.sources.clear()
    this.epoch = Date.now()
  }

  private key(chatId: string, id: string): string { return JSON.stringify([chatId, id]) }

  /**
   * Register only a gateway-observed source, then gate delivery on admission.
   * Old/missing timestamps cannot reconstruct a fresh allowance after restart.
   */
  async admit<T>(chatId: string, id: string, timestamp: unknown, admit: () => Promise<T>): Promise<T | undefined> {
    const now = Date.now()
    const received = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN
    const key = this.key(chatId, id)
    if (this.sources.has(key)) return undefined
    for (const [key, source] of this.sources) {
      if (source.deadline <= now) { source.settle(); this.sources.delete(key) }
    }
    // Ingress still works when tracking cannot safely establish a reply window.
    if (!Number.isFinite(received) || received < this.epoch || received > now
      || received + WINDOW_MS <= now || this.sources.size >= MAX_SOURCES) return admit()
    let settle!: () => void
    const source: Source = {
      deadline: received + WINDOW_MS, limit: chatId.startsWith('group:') ? 5 : 4,
      used: 0, accepted: false, ready: new Promise(resolve => { settle = resolve }),
      settle: () => settle(), tail: Promise.resolve(), blocked: false,
    }
    this.sources.set(key, source)
    try {
      const result = await admit()
      source.accepted = true
      return result
    } finally {
      // A rejected source stays unaccepted until it expires; replay cannot admit it.
      source.settle()
    }
  }

  async send<T>(chatId: string, id: string | undefined, count: number, operation: (next: () => number) => Promise<T>): Promise<T> {
    const key = this.key(chatId, id ?? '')
    const source = id ? this.sources.get(key) : undefined
    if (!source) throw new QQDeliveryError('invalid_source', 'rejected')
    await source.ready
    const check = (required: number) => {
      if (this.sources.get(key) !== source || !source.accepted) throw new QQDeliveryError('invalid_source', 'rejected')
      if (Date.now() >= source.deadline) throw new QQDeliveryError('expired', 'rejected')
      if (source.blocked) throw new QQDeliveryError('unknown', 'unknown')
      if (source.used + required > source.limit) throw new QQDeliveryError('quota', 'rejected')
    }
    const task = source.tail.then(async () => {
      check(count)
      try {
        return await operation(() => {
          check(1)
          // Reserve before I/O. Even a rejected/unknown request is never refunded.
          return ++source.used
        })
      } catch (error) {
        // Unknown delivery or platform rejection is not an invitation to retry.
        if (error instanceof QQDeliveryError) source.blocked = true
        throw error
      }
    })
    source.tail = task.catch(() => {})
    return task
  }
}
