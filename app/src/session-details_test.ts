import assert from 'node:assert/strict'
import test from 'node:test'
import { i18n } from './i18n.ts'
import { cacheRate, contextCapacity, contextPercent, formatTokenCount, parseSessionDetails, type SessionDetails } from './session-details.ts'

const details: SessionDetails = {
  sessionId: 'web:chat-example',
  name: 'Inspect the source',
  workdir: { kind: 'local', displayPath: 'C:\\folders\\shadow' },
  usage: { promptTokens: 40_000, completionTokens: 5_000, totalTokens: 45_000 },
  usageScope: 'session',
  context: { usedTokens: 20_000, windowTokens: 100_000 },
}

test('compact token counts use the same K/M/B units in English and Chinese', () => {
  const previousLocale = i18n.global.locale.value
  try {
    for (const locale of ['en', 'zh-CN'] as const) {
      i18n.global.locale.value = locale
      for (const [count, expected] of [
        [0, '0'], [999, '999'], [1000, '1K'], [12345, '12.3K'],
        [40000, '40K'], [999950, '1M'], [1250000, '1.3M'],
        [100000000, '100M'], [1000000000, '1B'],
      ] as const) assert.equal(formatTokenCount(count), expected, `${locale}: ${count}`)
    }
  } finally { i18n.global.locale.value = previousLocale }
})

test('session details preserve actual paths and distinguish context from lifetime tokens', () => {
  const parsed = parseSessionDetails(details, details.sessionId)
  assert.deepEqual(parsed, details)
  assert.equal(contextPercent(parsed.context), 20)
  assert.equal(formatTokenCount(40_000), '40K')
  assert.equal(formatTokenCount(1_250_000), '1.3M')
})

test('unreported usage and remote paths remain unknown rather than fabricated', () => {
  const parsed = parseSessionDetails({
    ...details, name: null, workdir: { kind: 'remote', displayPath: null }, usage: null,
    context: { usedTokens: null, windowTokens: null },
  }, details.sessionId)
  assert.equal(parsed.workdir.displayPath, null)
  assert.equal(parsed.usage, null)
  assert.equal(contextPercent(parsed.context), null)
  assert.equal(contextPercent({ usedTokens: 0, windowTokens: 100_000 }), 0)
  assert.equal(contextPercent({ usedTokens: 120_000, windowTokens: 100_000 }), 120)
})

test('total and delegated usage are validated independently, with explicit incomplete accounting', () => {
  const value = { ...details, subagentUsage: { promptTokens: 123, completionTokens: 7, totalTokens: 130 }, usageIncomplete: true }
  assert.deepEqual(parseSessionDetails(value, details.sessionId), value)
  for (const subagentUsage of [{ promptTokens: -1, completionTokens: 0, totalTokens: 0 }, {}, '130']) {
    assert.throws(() => parseSessionDetails({ ...value, subagentUsage }, details.sessionId), /session details/)
  }
  assert.throws(() => parseSessionDetails({ ...value, usageIncomplete: 'yes' }, details.sessionId), /session details/)
})

test('remote details retain display-only device identity and current availability', () => {
  const workdir = {
    kind: 'remote', nodeId: 'wsl', nodeName: 'WSL Ubuntu',
    displayName: 'Test workspace', displayPath: '/home/user/workdir', available: false,
  }
  assert.deepEqual(parseSessionDetails({ ...details, workdir }, details.sessionId).workdir, workdir)
  for (const invalid of [{ nodeId: 1 }, { nodeName: {} }, { displayName: null }, { available: 'online' }]) {
    assert.throws(() => parseSessionDetails({ ...details, workdir: { ...workdir, ...invalid } }, details.sessionId), /session details/)
  }
})

test('session details reject cross-session, malformed and nonfinite measurements', () => {
  for (const value of [
    null, [], {}, '<html>old backend</html>', { ...details, sessionId: 'another-session' },
    { ...details, workdir: { kind: 'local', displayPath: 123 } },
    { ...details, usageScope: 'estimated' },
    { ...details, usage: { ...details.usage, totalTokens: -1 } },
    { ...details, usage: undefined },
    ...[-1, 1.5, Infinity, NaN, '100'].map(usedTokens => ({ ...details, context: { ...details.context, usedTokens } })),
    { ...details, context: { usedTokens: 2, windowTokens: 0 } },
  ]) assert.throws(() => parseSessionDetails(value, details.sessionId), /session details/)
})

test('capacity preserves unknowns, clips geometry and uses actual handoff budget', () => {
  assert.deepEqual(contextCapacity({ usedTokens: null, windowTokens: 400_000 }), {
    usedPercent: null, remainingTokens: null, overflowTokens: null, markers: [],
  })
  const capacity = contextCapacity({ usedTokens: 450_000, windowTokens: 400_000,
    handoff: { enabled: false, low: .75, high: .95, windowTokens: 400_000 } })
  assert.equal(capacity.usedPercent, 100)
  assert.equal(capacity.remainingTokens, 0)
  assert.equal(capacity.overflowTokens, 50_000)
  assert.deepEqual(capacity.markers, [
    { kind: 'low', ratio: .75, tokens: 300_000, percent: 75 },
    { kind: 'high', ratio: .95, tokens: 380_000, percent: 95 },
  ])
  assert.equal(contextCapacity({ usedTokens: 0, windowTokens: 400_000 }).remainingTokens, 400_000)
})

test('optional handoff policy validates numeric thresholds and enabled state', () => {
  const handoff = { enabled: false, low: .6, high: .9, windowTokens: 400_000 }
  assert.deepEqual(parseSessionDetails({ ...details, context: { ...details.context, handoff } }, details.sessionId).context.handoff, handoff)
  for (const invalid of [{ low: NaN }, { high: Infinity }, { low: -1 }, { high: 1.1 }, { enabled: 'true' }, { windowTokens: 0 }]) {
    assert.throws(() => parseSessionDetails({ ...details, context: { ...details.context, handoff: { ...handoff, ...invalid } } }, details.sessionId))
  }
})

test('cache usage preserves unknown versus zero and uses input-token denominator', () => {
  const usage = { ...details.usage!, cachedTokens: 10_000 }
  const parsed = parseSessionDetails({ ...details, usage }, details.sessionId)
  assert.equal(parsed.usage?.cachedTokens, 10_000)
  assert.equal(cacheRate(parsed.usage), 25)
  assert.equal(cacheRate(details.usage), null)
  assert.equal(cacheRate({ ...usage, cachedTokens: 0 }), 0)
  assert.equal(cacheRate({ promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0 }), null)
  for (const cachedTokens of [-1, 40_001, NaN, 0.5, '0']) {
    assert.throws(() => parseSessionDetails({ ...details, usage: { ...usage, cachedTokens } }, details.sessionId))
  }
})

test('partial cache rates use covered inputs and reject malformed coverage', () => {
  const usage = { promptTokens: 1000, completionTokens: 100, totalTokens: 1100,
    cachedTokens: 400, cacheReportedPromptTokens: 500 }
  assert.deepEqual(parseSessionDetails({ ...details, usage }, details.sessionId).usage, usage)
  assert.equal(cacheRate(usage), 80)
  assert.equal(cacheRate({ ...usage, cachedTokens: 0, cacheReportedPromptTokens: 0 }), null)
  for (const cacheReportedPromptTokens of [-1, 399, 1001, 0.5, NaN, '500']) {
    assert.throws(() => parseSessionDetails({ ...details, usage: { ...usage, cacheReportedPromptTokens } }, details.sessionId))
  }
  assert.throws(() => parseSessionDetails({ ...details, usage: { ...details.usage, cacheReportedPromptTokens: 10 } }, details.sessionId))
})
