import assert from 'node:assert/strict'
import { test } from 'node:test'
import { copilotUsage, deepseekUsage, fetchAccountUsage, isOfficialDeepSeek, unavailableUsage } from './account-usage.ts'

const copilot = (snapshot: object, tokenBased = true) => copilotUsage({ token_based_billing: tokenBased,
  quota_snapshots: { premium_interactions: { unlimited: false, ...snapshot } } })

test('Copilot only shows positive finite credit entitlements with corresponding remaining amounts', () => {
  assert.deepEqual(copilot({ entitlement: '100.25', quota_remaining: '99.75', remaining: 100, credits_used: 95 }),
    { kind: 'copilot-credits', allowance: 100.25, used: 0.5 })
  assert.deepEqual(copilot({ entitlement: 100, quota_remaining: 0 }), { kind: 'copilot-credits', allowance: 100, used: 100 })
  assert.deepEqual(copilot({ entitlement: 100, quota_remaining: 100 }), { kind: 'copilot-credits', allowance: 100, used: 0 })
  for (const snapshot of [
    { entitlement: 0, quota_remaining: 0 }, { entitlement: 100, quota_remaining: 0, unlimited: true },
    { entitlement: 100, remaining: 20, percent_remaining: 20 }, { entitlement: 100, quota_remaining: 101 },
    { entitlement: 100, quota_remaining: -1 }, { entitlement: 100, quota_remaining: ' ' },
    { entitlement: Infinity, quota_remaining: 0 },
  ]) assert.deepEqual(copilot(snapshot), unavailableUsage)
  assert.deepEqual(copilot({ entitlement: 100, quota_remaining: 10 }, false), unavailableUsage)
})

test('DeepSeek only exposes validated monetary amounts and never follows custom endpoints', () => {
  for (const origin of ['https://api.deepseek.com', 'https://api.deepseek.com/v1/']) assert.ok(isOfficialDeepSeek(origin))
  for (const origin of ['https://api.deepseek.com.evil.invalid', 'http://api.deepseek.com', 'https://api.deepseek.com:444',
    'https://custom@api.deepseek.com', 'https://api.deepseek.com/?token=secret', 'https://api.deepseek.com/custom']) {
    assert.equal(isOfficialDeepSeek(origin), false)
  }
  assert.deepEqual(deepseekUsage({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '10.05' }] }),
    { kind: 'deepseek-balance', sufficient: true, balances: [{ currency: 'USD', total: '10.05' }] })
  for (const balance_infos of [[], [{ currency: 'EUR', total_balance: '4.00' }], [{ currency: 'USD', total_balance: 'bad' }],
    [null], [{ currency: 'USD', total_balance: 1 }]]) {
    assert.deepEqual(deepseekUsage({ is_available: true, balance_infos }), unavailableUsage)
  }
})

test('unparseable, redirected and aborted requests only yield unavailable', async () => {
  const cancelled = AbortSignal.abort(new Error('synthetic sensitive reason'))
  for (const request of [async () => Response.redirect('https://other.invalid'), async () => new Response('{'),
    async (_url: unknown, init?: RequestInit) => { init?.signal?.throwIfAborted(); throw new Error('expected signal') }]) {
    assert.deepEqual(await fetchAccountUsage(request as typeof fetch, 'https://api.deepseek.com/user/balance', {}, deepseekUsage, cancelled), unavailableUsage)
  }
})
