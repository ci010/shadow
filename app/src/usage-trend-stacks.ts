import type { ProjectUsage } from '../../src/projects/usage-contract.ts'
import { measure, type UsageMetric } from './usage-breakdown.ts'
import type { CostUnit } from './project-usage-charts.ts'

export interface UsageStack { id: string; name: string; values: (number | null)[] }
export function buildUsageStacks(projects: readonly { id: string; name: string; usage?: ProjectUsage | null }[], dates: string[],
  group: 'project' | 'model', metric: UsageMetric, unit: CostUnit, labels: { project: string; unnamed: string }): UsageStack[] {
  const stacks = new Map<string, UsageStack>()
  const datesByIndex = new Map(dates.map((date, index) => [date, index]))
  function add(id: string, name: string, index: number, value: number | null) {
    if (value === null) return
    let stack = stacks.get(id)
    if (!stack) { stack = { id, name, values: dates.map(() => null) }; stacks.set(id, stack) }
    stack.values[index] = (stack.values[index] ?? 0) + value
  }
  for (const project of projects) for (const day of project.usage?.daily ?? []) {
    const index = datesByIndex.get(day.date)
    if (index === undefined) continue
    const total = measure(day, metric, unit).value
    if (group === 'project') { add(project.id, project.name || labels.project, index, total); continue }
    let attributed = 0
    for (const model of day.models ?? []) {
      const value = measure(model, metric, unit).value
      attributed += value ?? 0
      if (value !== null && value > 0) add(`model:${model.name}`, model.name, index, value)
    }
    if (total !== null && (total === 0 || total - attributed > Math.abs(total) * 1e-12)) {
      add('unattributed', labels.unnamed, index, total - attributed)
    }
  }
  const series = [...stacks.values()]
  if (group === 'project' || series.length <= 10) return series
  const total = (row: UsageStack) => row.values.reduce<number>((sum, value) => sum + (value ?? 0), 0)
  series.sort((a, b) => total(b) - total(a) || a.id.localeCompare(b.id))
  const kept = series.filter(row => row.id !== 'unattributed').slice(0, 9)
  const other = series.filter(row => !kept.includes(row))
  return [...kept, { id: 'unattributed', name: labels.unnamed, values: dates.map((_, i) =>
    other.some(row => row.values[i] != null) ? other.reduce((sum, row) => sum + (row.values[i] ?? 0), 0) : null) }]
}
