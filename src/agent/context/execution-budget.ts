export const SESSION_ITERATION_LIMIT = 1000

export class InferenceBudget {
  private used = 0

  constructor(private readonly limit: number | null = SESSION_ITERATION_LIMIT) {
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new RangeError('Invalid inference budget')
  }

  get remaining(): number | undefined { return this.limit === null ? undefined : this.limit - this.used }

  get hasRemaining(): boolean { return this.limit === null || this.used < this.limit }

  take(reserve = 0): void {
    if (!Number.isSafeInteger(reserve) || reserve < 0) throw new RangeError('Invalid inference reservation')
    if (this.limit === null) return
    if (this.limit - this.used <= reserve) throw new Error('Inference budget exhausted; nested infer must leave one request for the parent.')
    this.used++
  }
}
