/** Read failures are retired only by later successful, complete coverage of the same resource.
 * Argument identity is deliberately not used: a large failed read may be repaired by pages. */
export class ReadCoverage {
  private failures: { path: string; start: number; end: number; error: string; spans: [number, number][]; total?: number }[] = []
  fail(path: string, args: Record<string, unknown>, error: string): void {
    const start = Number.isSafeInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 1
    const end = Number.isSafeInteger(args.limit) && Number(args.limit) > 0 ? start + Number(args.limit) : Infinity
    this.failures.push({ path, start, end, error, spans: [] })
  }
  success(path: string, args: Record<string, unknown>, text: string): void {
    if (!Number.isSafeInteger(args.offset) || Number(args.offset) < 1) return
    // List mode and token-truncated partial lines are not evidence of full line consumption.
    if (typeof args.flag === 'string' && args.flag.includes('l')) return
    const start = Number.isSafeInteger(args.offset) && Number(args.offset) > 0 ? Number(args.offset) : 1
    const limit = Number(args.limit)
    if (!Number.isSafeInteger(limit) || limit < 1) return
    // Only the exact terminal footer emitted by ReadTool is metadata. Historical
    // transcripts can contain arbitrary nested read results, including footers.
    const marker = text.match(/\n\n\[truncated: showing lines (\d+)-(\d+) of (\d+); use offset=(\d+) to continue\]$/)
      ?? text.match(/\n\n\[truncated: token budget; showing complete lines (\d+)-(\d+) of (\d+); use offset=(\d+) to continue\]$/)
    let end: number, total: number
    if (marker) {
      const first = Number(marker[1]), last = Number(marker[2]), count = Number(marker[3])
      const body = text.slice(0, marker.index)
      if (body.includes('[truncated:') || first !== start || last < first || last >= start + limit
        || count < last || Number(marker[4]) !== last + 1
        || body.split('\n').length !== last - first + 1) return
      end = last + 1; total = count
    } else {
      // Empty/out-of-range reads and cache/non-content receipts cannot prove EOF.
      // Any nested marker makes an unframed result ambiguous, so fail closed.
      if (!text || text.includes('[truncated:') || /^\[[^\n]*\]$/.test(text)
        || /^(Error|Blocked:|Tool execution aborted:)/.test(text)) return
      const count = text.split('\n').length
      if (count > limit) return
      end = start + count; total = end - 1
    }
    for (const failure of this.failures.filter(item => item.path === path)) {
      failure.spans.push([start, end]); failure.total = total
    }
    this.failures = this.failures.filter(failure => {
      if (failure.total === undefined) return true
      let cursor = failure.start
      for (const [from, to] of failure.spans.sort((a, b) => a[0] - b[0])) {
        if (from > cursor) break
        cursor = Math.max(cursor, to)
      }
      return cursor < Math.min(failure.end, failure.total + 1)
    })
  }
  errors(): string[] { return this.failures.map(item => `${item.path} lines [${item.start}, ${item.end}): ${item.error}. Recover by reading this exact resource with explicit positive offset in complete pages; different views/aliases do not prove coverage.`) }
}
