import type { EditorGroups } from './editor-groups.ts'
import type { SessionStage } from './session-activity.ts'

/** A successful full activity snapshot omits inactive sessions. Missing activity
 * is only evidence of inactivity after that snapshot has loaded, never before. */
export function canReplaceIdleConversation(stage: SessionStage | null | undefined, protectedState: boolean,
  activityKnown = false): boolean {
  return !protectedState && (stage === 'idle' || stage === 'inactive' || (stage == null && activityKnown))
}

/** Close only the conversation selected when sidebar navigation began. */
export function closePreviousSidebarConversation(groups: EditorGroups, previousId: string | undefined,
  nextOwner: string | undefined, canClose: () => boolean): void {
  const previous = previousId ? groups.descriptors.get(previousId) : undefined
  if (!previous?.conversation || previous.owner === nextOwner || !nextOwner || !canClose()) return
  groups.close(previous.id)
}
