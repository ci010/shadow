import type { EChartsCoreOption } from 'echarts/core'

export interface UsageChartDatum {
  date: string
  value: number | null
  /** Localized exact value, unit, and missing-telemetry information. */
  label: string
  partial: boolean
}
export interface UsageChartColors {
  primary: string; text: string; muted: string; border: string; surface: string; selection: string
}

/** ECharts owns scales, hit testing, axes and tooltips; this adapter only describes data. */
export function usageChartOption(
  title: string, kind: 'bar' | 'line', points: UsageChartDatum[], colors: UsageChartColors,
  formatAxis: (value: number) => string, minInterval = 0,
): EChartsCoreOption {
  return {
    animation: false,
    textStyle: { fontFamily: 'Inter, system-ui, sans-serif', color: colors.text },
    grid: { left: 12, right: 16, top: 24, bottom: 12, outerBoundsMode: 'same', outerBoundsContain: 'axisLabel' },
    tooltip: {
      trigger: 'axis', triggerOn: 'mousemove|click', confine: true,
      renderMode: 'html', transitionDuration: 0, borderRadius: 0,
      extraCssText: 'max-width: min(280px, calc(100% - 24px)); white-space: normal; overflow-wrap: anywhere; box-shadow: none; line-height: 1.6;',
      backgroundColor: colors.surface, borderColor: colors.border, borderWidth: 1,
      textStyle: { color: colors.text, fontSize: 12 },
      axisPointer: { type: kind === 'bar' ? 'shadow' : 'line',
        shadowStyle: { color: colors.selection, opacity: 0.6 },
        lineStyle: { color: colors.muted, type: 'dashed' } },
      formatter: (params: { dataIndex?: number } | { dataIndex?: number }[]) => {
        const index = (Array.isArray(params) ? params[0] : params)?.dataIndex
        const point = index === undefined ? undefined : points[index]
        if (!point) return ''
        // HTML is used for wrapped, viewport-confined tooltips. Never interpolate
        // labels as markup (the same component can receive future server labels).
        return `${escapeTooltip(point.date)}<br/>${escapeTooltip(point.label.slice(point.date.length + 2))}`
      },
    },
    xAxis: {
      type: 'category', data: points.map(p => p.date), boundaryGap: kind === 'bar',
      axisTick: { show: false }, axisLine: { lineStyle: { color: colors.border } },
      axisLabel: { color: colors.muted, fontSize: 11, hideOverlap: true, formatter: (date: string) => date.slice(5) },
      axisPointer: { snap: true },
    },
    yAxis: {
      type: 'value', min: 0, minInterval, splitNumber: 3,
      // A wholly zero series still has a useful axis, without changing its values.
      ...(points.every(p => p.value === null || p.value === 0) ? { max: 1 } : {}),
      axisLabel: { color: colors.muted, fontSize: 11, formatter: formatAxis },
      splitLine: { lineStyle: { color: colors.border, type: 'dashed' } },
    },
    series: [{
      id: 'usage', name: title, type: kind,
      ...(kind === 'bar' ? { barMaxWidth: 48, barMinHeight: 1 } : {
        connectNulls: false, showSymbol: true, symbolSize: 7, lineStyle: { width: 2, color: colors.primary },
      }),
      emphasis: { focus: 'series', itemStyle: { color: colors.primary, borderColor: colors.text, borderWidth: 2 } },
      data: points.map(p => ({
        value: p.value,
        itemStyle: { color: colors.primary, opacity: p.partial ? 0.6 : 1,
          borderColor: p.partial ? colors.text : colors.primary,
          borderWidth: p.partial ? 1 : 0, borderType: p.partial ? 'dashed' : 'solid' },
      })),
    }],
  }
}

function escapeTooltip(value: string) {
  const escaped: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }
  return value.replace(/[&<>"']/g, char => escaped[char]!)
}
