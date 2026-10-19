import assert from 'node:assert/strict'
import { test } from 'node:test'
import { estimateUsageCost } from './cost.ts'
import { addTokenUsage, parseTokenUsage, readTokenUsage } from '../sessions/usage.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { join } from 'node:path'
const usage = { promptTokens: 1_000_000, completionTokens: 1_000_000, totalTokens: 2_000_000, cachedTokens: 400_000 }
test('DeepSeek hit/miss, aliases, off-peak and unknown holiday windows', () => {
  const at = new Date('2026-10-18T08:00:00Z')
  const result = estimateUsageCost('deepseek', 'deepseek-flash', usage, at)
  assert.ok(Math.abs(result.costs![0].amount - 0.6912) < 1e-10)
  assert.equal(result.costs![0].currency, 'USD')
  assert.deepEqual(estimateUsageCost('deepseek', 'deepseek-v4-flash', usage, at), result)
  assert.equal(estimateUsageCost('deepseek', 'deepseek-flash', usage, new Date('2026-10-19T08:00:00Z')).costIncomplete, true)
  for (const model of ['unknown', '__proto__', 'toString']) assert.equal(estimateUsageCost('deepseek', model, usage, at).costs, undefined)
  assert.equal(estimateUsageCost('deepseek', 'deepseek-flash', { ...usage, cachedTokens: undefined }, at).costs, undefined)
})
test('Copilot token AI credits, long context and explicit Claude/Astra cache-write reports', () => {
  assert.equal(estimateUsageCost('copilot', 'gpt-5-mini', usage).costs![0].amount, 216)
  assert.equal(estimateUsageCost('copilot', 'gpt-5.4', usage).costs![0].amount, 2570)
  assert.equal(estimateUsageCost('copilot', 'claude-sonnet-4.6', usage).costIncomplete, true)
  const result = estimateUsageCost('copilot', 'claude-sonnet-4.6', { ...usage, cacheWriteTokens: 100_000 })
  assert.equal(result.costs![0].amount, 1699.5)
  assert.equal(result.costs![0].currency, 'AI_CREDITS')
  assert.equal(estimateUsageCost('copilot', 'gpt-6-astra', { ...usage, cacheWriteTokens: 0 }).costs![0].amount, 8780)
})
test('mixed currency validation and partial accumulation', () => {
  const usd = { ...usage, costs: [{ amount: 0.1, currency: 'USD' as const }] }
  const credits = { ...usage, costs: [{ amount: 2, currency: 'AI_CREDITS' as const }] }
  assert.deepEqual(addTokenUsage(usd, credits)?.costs, [...usd.costs, ...credits.costs])
  assert.equal(addTokenUsage(usd, usage)?.costIncomplete, true)
  assert.equal(addTokenUsage(usage, usd)?.costIncomplete, true)
  for (const amount of [NaN, Infinity, -1]) assert.equal(parseTokenUsage({ ...usage, costs: [{ amount, currency: 'USD' }] }), null)
  assert.equal(parseTokenUsage({ ...usage, costs: [{ amount: 1, currency: 'EUR' }] }), null)
  assert.equal(parseTokenUsage({ ...usage, costIncomplete: 'yes' }), null)
  assert.deepEqual(parseTokenUsage(usage), usage)
})
for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: costs survive restart, deduplication and assistant history`, async () => {
    await withTempWorkspace(async workspace => {
      const directory = join(workspace, 'sessions')
      let store = new Store(directory)
      await store.init()
      const priced = estimateUsageCost('copilot', 'gpt-5-mini', usage)
      const event = { type: 'model_usage', sessionId: 'web:cost', id: 'one', usage: priced }
      try {
        await store.createSessionLog('web_cost-0', [event, event,
          { role: 'assistant', content: 'response', usage: priced },
          { type: 'model_usage', sessionId: 'web:cost', id: 'two', usage }])
        store.close?.()
        store = new Store(directory)
        await store.init()
        const result = await readTokenUsage(store, { sessionId: 'web:cost', segmentIndex: 0 })
        assert.deepEqual(result.usage?.costs, priced.costs)
        assert.equal(result.usage?.costIncomplete, true)
        const records = []
        for await (const record of store.readSessionLog('web_cost-0')) records.push(record)
        assert.deepEqual(records.find(record => record.role === 'assistant')?.usage, priced)
      } finally { store.close?.() }
    })
  })
}

test('missing writes yield only a lower bound; invalid or unknown inputs remain unknown', () => {
  for (const model of ['claude-sonnet-4.6', 'gpt-6-astra']) {
    const lower = estimateUsageCost('copilot', model, usage)
    const zero = estimateUsageCost('copilot', model, { ...usage, cacheWriteTokens: 0 })
    assert.ok(lower.costs)
    assert.ok(Math.abs(lower.costs[0].amount - (model === 'gpt-6-astra' ? 8780 : 1692)) < 1e-9)
    assert.deepEqual(lower.costs, zero.costs)
    assert.equal(lower.costIncomplete, true)
    assert.equal(zero.costIncomplete, undefined)
    const written = estimateUsageCost('copilot', model, { ...usage, cacheWriteTokens: 100_000 })
    assert.ok(written.costs![0].amount > lower.costs![0].amount)
    for (const cacheWriteTokens of [null, -1, NaN, Infinity, 0.5, 600_001, '0']) {
      const invalid = estimateUsageCost('copilot', model, { ...usage, cacheWriteTokens } as any)
      assert.equal(invalid.costs, undefined)
      assert.equal(invalid.costIncomplete, true)
    }
    for (const override of [{ cachedTokens: undefined }, { cachedTokens: -1 }, { cacheReportedPromptTokens: 500_000 }]) {
      assert.equal(estimateUsageCost('copilot', model, { ...usage, ...override }).costs, undefined)
    }
    for (const pair of [[lower, usage], [usage, lower], [lower, zero]]) {
      const sum = addTokenUsage(pair[0], pair[1])!
      assert.equal(sum.costIncomplete, true)
      assert.equal(sum.costs![0].amount, lower.costs![0].amount + (pair.includes(zero) ? zero.costs![0].amount : 0))
    }
  }
  assert.equal(estimateUsageCost('copilot', 'unknown', usage).costs, undefined)
})

test('GPT-6.1 Sol pricing includes its strict 272K long-context threshold and cache-write lower bound', () => {
  const base = { promptTokens: 272_000, cachedTokens: 200_000, completionTokens: 1_000, totalTokens: 273_000 }
  const short = estimateUsageCost('copilot', 'gpt-6.1-sol', base)
  assert.equal(short.costs![0].currency, 'AI_CREDITS')
  assert.ok(Math.abs(short.costs![0].amount - 17.4) < 1e-10)
  assert.equal(short.costIncomplete, true)
  const complete = estimateUsageCost('copilot', 'gpt-6.1-sol', { ...base, cacheWriteTokens: 10_000 })
  assert.ok(Math.abs(complete.costs![0].amount - 17.9) < 1e-10)
  assert.equal(complete.costIncomplete, undefined)
  const long = estimateUsageCost('copilot', 'gpt-6.1-sol', { ...base, promptTokens: 272_001, totalTokens: 273_001, cacheWriteTokens: 10_000 })
  assert.ok(Math.abs(long.costs![0].amount - 35.3004) < 1e-10)
  assert.equal(long.costIncomplete, undefined)
})

const addedCopilotRates = [
  ['gpt-5.6-luna', 200_000, [0.2, 0.02, 1.2, 0.25], [0.4, 0.04, 1.8, 0.5]],
  ['gpt-5.6-sol', 272_000, [4, 0.4, 20, 5], [8, 0.8, 30, 10]],
  ['gpt-5.6-terra', 272_000, [2, 0.2, 12, 2.5], [4, 0.4, 18, 5]],
  ['gpt-6-luna', 272_000, [0.1, 0.01, 0.5, 0.125], [0.2, 0.02, 0.75, 0.25]],
  ['gpt-6-sol', 272_000, [2, 0.2, 10, 2.5], [4, 0.4, 15, 5]],
  ['grok-4.5', 200_000, [2, 0.5, 6], [4, 1, 12]],
  ['grok-4.6', 200_000, [2, 0.5, 6], [4, 1, 12]],
  ['grok-4.7', 200_000, [2, 0.5, 6], [4, 1, 12]],
] as const
for (const [model, threshold, standard, long] of addedCopilotRates) {
  test(`${model}: official standard/long-context prices include cache and strict threshold`, () => {
    for (const input of [threshold - 1, threshold, threshold + 1]) {
      const rates = input > threshold ? long : standard
      const writes = rates.length === 4 ? 1_000 : 0
      const tokens = { promptTokens: input, cachedTokens: 2_000, completionTokens: 500,
        totalTokens: input + 500, ...(writes ? { cacheWriteTokens: writes } : {}) }
      const result = estimateUsageCost('copilot', model, tokens)
      const expected = ((input - 2_000 - writes) * rates[0] + 2_000 * rates[1]
        + 500 * rates[2] + writes * (rates[3] ?? rates[0])) / 10_000
      assert.equal(result.costs![0].currency, 'AI_CREDITS')
      assert.ok(Math.abs(result.costs![0].amount - expected) < 1e-9)
      assert.equal(result.costIncomplete, undefined)
      const missingWrite = estimateUsageCost('copilot', model, { ...tokens, cacheWriteTokens: undefined })
      assert.ok(missingWrite.costs)
      assert.equal(missingWrite.costIncomplete, writes ? true : undefined)
    }
  })
}
test('unverified GPT-5.6 Sol fast pricing is never borrowed from regular Sol', () => {
  assert.equal(estimateUsageCost('copilot', 'gpt-5.6-sol-fast', usage).costs, undefined)
  assert.equal(estimateUsageCost('copilot', 'gpt-5.6-sol-fast', usage).costIncomplete, true)
})
