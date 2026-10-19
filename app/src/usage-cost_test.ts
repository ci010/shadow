import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatUsageCost, validCostUsage } from './usage-cost.ts'
import { i18n } from './i18n.ts'

test('cost payload accepts old usage and separate currency units; rejects invalid amounts', () => {
  assert.equal(validCostUsage({}), true)
  assert.equal(validCostUsage({ costs: [{ amount: 0.123, currency: 'AI_CREDITS' }], costIncomplete: true }), true)
  for (const amount of [-1, NaN, Infinity, '1']) assert.equal(validCostUsage({ costs: [{ amount, currency: 'USD' }] }), false)
  assert.equal(validCostUsage({ costs: [{ amount: 1, currency: 'EUR' }] }), false)
  assert.equal(validCostUsage({ costs: null }), false)
  assert.equal(validCostUsage({ costs: [] }), false)
  assert.equal(validCostUsage({ costs: [{ amount: 1, currency: 'USD' }, { amount: 2, currency: 'USD' }] }), false)
  assert.equal(validCostUsage({ costIncomplete: 'yes' }), false)
})

test('cost display preserves tiny nonzero costs and labels credits distinctly', () => {
  assert.match(formatUsageCost({ amount: 0.0000001, currency: 'USD' }), /^USD 0\.0000001$/)
  assert.match(formatUsageCost({ amount: 1.25, currency: 'AI_CREDITS' }), /1\.25 AI credits/)
  assert.equal(formatUsageCost({ amount: 0, currency: 'CNY' }), 'CNY 0')
})

test('estimated-cost labels are localized without treating credits as currency', () => {
  const previous = i18n.global.locale.value
  try {
    i18n.global.locale.value = 'zh-CN'
    assert.equal(i18n.global.t('Known cost subtotal (incomplete)'), '已知费用小计（不完整）')
    assert.equal(i18n.global.t('Cost could not be estimated'), '未能估算费用')
    assert.equal(i18n.global.t('Estimated cost'), '预估消耗')
    assert.equal(i18n.global.t('Cost estimate incomplete'), '费用估算不完整')
    assert.equal(formatUsageCost({ amount: 1.25, currency: 'AI_CREDITS' }), '1.25 AI credits')
  } finally { i18n.global.locale.value = previous }
})
