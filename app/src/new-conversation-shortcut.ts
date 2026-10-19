import { t } from './i18n.ts'
import type { FolderRecord } from './folders-client.ts'

export interface NewConversationContext {
  projectId: string
  sessionId: string
  folder?: FolderRecord
}

/** Persistent v-show/teleported dialogs must not block shortcuts while hidden. */
export function hasVisibleNewConversationOverlay(elements: Iterable<Pick<Element, 'getClientRects'>>): boolean {
  return Array.from(elements).some(element => element.getClientRects().length > 0)
}

/** Consume synchronously; cancel late metadata reads before they can steal navigation. */
export function createNewConversationShortcut(options: {
  context(): NewConversationContext | undefined
  resolveFolder(context: NewConversationContext, signal: AbortSignal): Promise<FolderRecord | undefined>
  start(context: NewConversationContext, folder?: FolderRecord): void
  failed(cause: unknown): void
}) {
  let pending: AbortController | undefined
  function cancel() { pending?.abort(); pending = undefined }
  async function keydown(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'repeat' | 'defaultPrevented' | 'isComposing' | 'preventDefault'>) {
    if (event.key.toLowerCase() !== 'n' || !(event.ctrlKey || event.metaKey) || event.ctrlKey && event.metaKey
      || event.altKey || event.shiftKey || event.repeat || event.defaultPrevented || event.isComposing) return
    const context = options.context()
    if (!context) return
    event.preventDefault()
    if (pending) return
    const controller = pending = new AbortController()
    try {
      const folder = context.sessionId ? await options.resolveFolder(context, controller.signal) : context.folder
      if (!controller.signal.aborted && options.context()) options.start(context, folder)
    } catch (cause) {
      if (!controller.signal.aborted && options.context()) options.failed(cause)
    } finally { if (pending === controller) pending = undefined }
  }
  return { keydown, cancel }
}

/** Unknown session/folder metadata is an error, not permission to drop the workdir. */
export async function resolveConversationFolder(
  sessionId: string,
  sessions: readonly { sessionId: string; folderId?: string }[],
  listFolders: () => Promise<FolderRecord[]>,
): Promise<FolderRecord | undefined> {
  const session = sessions.find(item => item.sessionId === sessionId)
  if (!session) throw new Error(t('The selected conversation is unavailable. Refresh and retry.'))
  if (!session.folderId) return
  const folder = (await listFolders()).find(item => item.id === session.folderId)
  if (!folder) throw new Error(t('The conversation folder is unavailable. Choose a folder or Start from scratch explicitly.'))
  return folder
}
