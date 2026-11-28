import type { ProjectTopTabGroup } from './project-top-tabs.ts'

/** Keep the local draggable tabs in their original Project slot on activation. */
export function surroundingProjectTabGroups(
  groups: readonly ProjectTopTabGroup[], projectId: string, projectOrder: readonly string[],
): { before: ProjectTopTabGroup[]; after: ProjectTopTabGroup[] } {
  const index = projectOrder.indexOf(projectId)
  return {
    before: groups.filter(group => projectOrder.indexOf(group.id) < index),
    after: groups.filter(group => projectOrder.indexOf(group.id) >= index),
  }
}
