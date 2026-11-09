/** Stable catalog source names are also callable names; `work` remains a policy capability only. */
export const WORK_TOOL_NAMES = ['work_create', 'work_update', 'work_assign', 'work_review', 'work_link'] as const
export function isWorkTool(name: string): boolean { return (WORK_TOOL_NAMES as readonly string[]).includes(name) }
