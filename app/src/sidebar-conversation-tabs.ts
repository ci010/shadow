import type { EditorGroups } from './editor-groups.ts'
import type { SessionStage } from './session-activity.ts'

/** Unknown activity is not evidence that a conversation is idle. */
export function canReplaceIdleConversation(stage: SessionStage | null, protectedState: boolean): boolean {
  return stage === 'idle' && !protectedState
}

/** Close only the conversation selected when sidebar navigation began. */
export function closePreviousSidebarConversation(groups: EditorGroups, previousId: string | undefined,
  nextOwner: string | undefined, canClose: () => boolean): void {
  const previous = previousId ? groups.descriptors.get(previousId) : undefined
  if (!previous?.conversation || previous.owner === nextOwner || !nextOwner || !canClose()) return
  groups.close(previous.id)
}
