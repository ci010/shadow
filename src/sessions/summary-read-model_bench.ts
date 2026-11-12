/** Synthetic cache-operation benchmark (not an HTTP/load or production-data test).
 * pnpm exec node --import tsx src/sessions/summary-read-model_bench.ts [rows]
 * No filesystem/runtime data access. Compares the previous full-state fingerprint
 * algorithm to navigation-only pull validation; times include dependency scans. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { SummaryRowCache } from './summary-read-model.ts'

const size = Number(process.argv[2] ?? 10000)
if (!Number.isSafeInteger(size) || size < 1) throw new Error('positive row count required')
for (const strategy of ['full-state', 'navigation-inputs'] as const) {
  const states = Array.from({ length: size }, (_, i) => ({ sessionId: `s${i}`, topic: `Session ${i}`, segmentIndex: 0,
    lastKnownTokens: 0, workingContext: 'context '.repeat(1024), config: { model: 'fixture' } }))
  const cache = new SummaryRowCache<object>(256 * 1024 * 1024)
  const scan = () => {
    let assembled = 0, fullStateSerializations = 0
    for (const state of states) {
      const input = strategy === 'full-state' ? (++fullStateSerializations, JSON.stringify(state))
        : [state.sessionId, state.topic, state.segmentIndex, state.config.model, false, false, false, 'default-model']
      if (!cache.get(state.sessionId, input)) {
        assembled++
        cache.set(state.sessionId, input, { sessionId: state.sessionId, title: state.topic })
      }
    }
    return { assembled, fullStateSerializations }
  }
  for (const scenario of ['cold', 'unchanged', 'single-row', 'execution-churn'] as const) {
    if (scenario === 'single-row') states[0]!.topic = 'Updated'
    if (scenario === 'execution-churn') for (const state of states) state.lastKnownTokens++
    const start = performance.now()
    const counters = scan()
    const ms = +(performance.now() - start).toFixed(2)
    if (strategy === 'navigation-inputs') {
      assert.equal(counters.fullStateSerializations, 0)
      assert.equal(counters.assembled, scenario === 'cold' ? size : scenario === 'single-row' ? 1 : 0)
    }
    console.log(JSON.stringify({ strategy, rows: size, scenario, ms, ...counters }))
  }
}
