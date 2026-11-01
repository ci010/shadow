import assert from 'node:assert/strict'
import test from 'node:test'
import { usageChartOption, type UsageChartDatum } from './usage-chart-options.ts'

const colors = { primary: '#245bc1', text: '#242424', muted: '#525252', border: '#dedede', surface: '#ffffff', selection: '#eaf1ff' }
const points: UsageChartDatum[] = [
  { date: '2026-10-01', value: 0, label: '2026-10-01: 0 USD', partial: false },
  { date: '2026-10-02', value: null, label: '2026-10-02: Unavailable', partial: true },
  { date: '2026-10-03', value: 484.02, label: '2026-10-03: 484.02 USD (partial; 1 calls missing)', partial: true },
]
const format = (n: number) => String(n)

test('bar adapter preserves nulls, zero and converted values without mutating telemetry', () => {
  const before = structuredClone(points)
  const option = usageChartOption('Daily cost', 'bar', points, colors, format)
  assert.deepEqual(option.xAxis.data, points.map(p => p.date))
  assert.deepEqual(option.series[0].data.map((d: { value: unknown }) => d.value), [0, null, 484.02])
  assert.equal(option.series[0].data[0].itemStyle.opacity, 1)
  assert.equal(option.series[0].data[2].itemStyle.borderType, 'dashed')
  assert.equal(option.series[0].data[2].itemStyle.opacity, 0.6)
  assert.equal(option.yAxis.min, 0)
  assert.equal(option.series[0].barMinHeight, 1)
  assert.deepEqual(points, before)
})

test('line adapter never connects missing days, has accessible exact labels outside the canvas', () => {
  const option = usageChartOption('Daily time', 'line', points, colors, format)
  assert.equal(option.series[0].connectNulls, false)
  assert.equal(option.series[0].data[1].value, null)
  assert.equal(option.tooltip.trigger, 'axis')
  assert.equal(option.tooltip.triggerOn, 'mousemove|click')
  assert.equal(option.tooltip.axisPointer.type, 'line')
  assert.equal(option.xAxis.boundaryGap, false)
  assert.equal(option.animation, false)
  assert.equal(option.tooltip.formatter([{ dataIndex: 2 }]), '2026-10-03<br/>484.02 USD (partial; 1 calls missing)')
  assert.equal(option.tooltip.formatter([{ dataIndex: 1 }]), '2026-10-02<br/>Unavailable')
})

test('themed confined tooltips escape all label markup; no HTML from data is trusted', () => {
  const malicious = [{ ...points[0], label: `2026-10-01: <img src=x onerror="x"> & 'value'` }]
  const option = usageChartOption('Cost', 'bar', malicious, colors, format)
  assert.equal(option.tooltip.renderMode, 'html')
  assert.equal(option.tooltip.confine, true)
  assert.match(option.tooltip.extraCssText, /overflow-wrap: anywhere/)
  assert.equal(option.tooltip.backgroundColor, colors.surface)
  assert.equal(option.tooltip.textStyle.color, colors.text)
  assert.equal(option.series[0].data[0].itemStyle.color, colors.primary)
  assert.equal(option.tooltip.formatter({ dataIndex: 0 }), '2026-10-01<br/>&lt;img src=x onerror=&quot;x&quot;&gt; &amp; &#39;value&#39;')
  assert.equal(option.tooltip.formatter([]), '')
  assert.equal(option.tooltip.formatter([{ dataIndex: 99 }]), '')
})

test('all-zero scales stay finite, while normal scales and axis precision are delegated to ECharts', () => {
  const option = usageChartOption('Cost', 'bar', points.slice(0, 1), colors, n => n.toFixed(5))
  assert.equal(option.yAxis.max, 1)
  assert.equal(option.yAxis.axisLabel.formatter(0.00001), '0.00001')
  assert.equal(usageChartOption('Cost', 'bar', points, colors, format).yAxis.max, undefined)
  assert.equal(usageChartOption('Tokens', 'bar', points.slice(0, 1), colors, format, 1).yAxis.minInterval, 1)
})
