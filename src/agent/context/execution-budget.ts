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
