import type { ToolCall } from '../providers/provider.ts'
import type { Tools } from '../tools/registry.ts'

export type Group = { readonly: boolean; calls: ToolCall[] }
export function groupTools(toolCalls: ToolCall[], reg: Tools): Array<Group> {
  const groups: Group[] = []
  for (const tc of toolCalls) {
    const isRo = reg.isReadonly(tc.name, tc.arguments)
    const last = groups[groups.length - 1]
    if (isRo && last?.readonly) {
      last.calls.push(tc)
    } else {
      groups.push({ readonly: isRo, calls: [tc] })
    }
  }
  return groups
}