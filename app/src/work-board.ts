import type { ProjectWorkItem } from '../../src/projects/work-overview.ts'
import { groupWork, workColumns } from './project-work.ts'

/** Group inside each status lane, rather than mounting a board per root. */
export function workBoardColumns(items: ProjectWorkItem[], all: ProjectWorkItem[]) {
  const groups = groupWork(items, all)
  return workColumns.filter(column => column.status !== null || items.some(item => item.status === null)).map(column => ({
    ...column,
    rows: groups.flatMap(group => group.items.filter(item => item.status === column.status).map((item, index) => ({
      key: item.key, item, groupTitle: group.title, startsGroup: index === 0,
    }))),
  }))
}
export type WorkBoardRow = ReturnType<typeof workBoardColumns>[number]['rows'][number]

export function measuredOffsets(keys: readonly string[], sizes: ReadonlyMap<string, number>, estimate = 180): number[] {
  const offsets = [0]
  for (const key of keys) offsets.push(offsets[offsets.length - 1]! + (sizes.get(key) ?? estimate))
  return offsets
}
export function measuredRange(offsets: readonly number[], top: number, height: number, overscan = 3) {
  const count = offsets.length - 1
  const find = (value: number) => {
    let low = 0, high = count
    while (low < high) { const mid = (low + high) >>> 1; if (offsets[mid + 1]! <= value) low = mid + 1; else high = mid }
    return low
  }
  return { start: Math.max(0, find(top) - overscan), end: Math.min(count, find(top + height) + overscan + 1) }
}
