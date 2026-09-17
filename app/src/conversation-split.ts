import { sessionNavigationParent, type SidebarSession } from './folders-sidebar.ts'

export const SPLIT_MIN_WIDTH = 1280
export const CHILD_MIN_WIDTH = 360
export const SPLIT_HANDLE_WIDTH = 8
const PRIMARY_MIN_WIDTH = 480
const FOLDERS_WIDTH = 260

export function childWidthBounds(workspaceWidth: number) {
  return { min: CHILD_MIN_WIDTH, max: Math.max(CHILD_MIN_WIDTH, Math.min(800, workspaceWidth - FOLDERS_WIDTH - PRIMARY_MIN_WIDTH - SPLIT_HANDLE_WIDTH)) }
}

export function clampChildWidth(width: number, workspaceWidth: number): number {
  const { min, max } = childWidthBounds(workspaceWidth)
  return Math.round(Math.max(min, Math.min(Number.isFinite(width) ? width : 480, max)))
}

/** Keep the current parent when inspecting a descendant; otherwise open its root. */
export function childConversationTarget(
  sessions: readonly SidebarSession[],
  childId: string,
  currentId: string,
): { primaryId: string; childId: string } | null {
  const byId = new Map(sessions.map(session => [session.sessionId, session]))
  const ancestors: string[] = []
  const seen = new Set([childId])
  let parentId = sessionNavigationParent(byId.get(childId))
  while (parentId && byId.has(parentId)) {
    if (seen.has(parentId)) return null
    seen.add(parentId)
    ancestors.push(parentId)
    parentId = sessionNavigationParent(byId.get(parentId))
  }
  if (!ancestors.length) return null
  return { childId, primaryId: ancestors.includes(currentId) ? currentId : ancestors[ancestors.length - 1] }
}
