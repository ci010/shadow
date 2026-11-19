import { shallowReactive, type InjectionKey } from 'vue'
import type { EditorGroups } from './editor-groups.ts'
import { appendChatAttachments, imageAttachmentReference, type PendingChatAttachment } from './chat-attachments.ts'

export interface OtioReview { text: string; file?: File }
export interface OtioDraftBridge {
  target(apiBase: string): { key: string; label: string } | null
  add(apiBase: string, key: string, review: OtioReview): boolean
}
export const OtioDraftKey: InjectionKey<OtioDraftBridge> = Symbol('OtioDraft')

interface ReviewDraft {
  key: string
  label: string
  text: string
  attachments: readonly PendingChatAttachment[]
  canAttachFiles: boolean
}

/** Resolve and stage synchronously so a rejected review cannot change either draft field. */
export function createOtioDraftBridge(
  resolve: (apiBase: string) => ReviewDraft | null,
  commit: (text: string, attachments: PendingChatAttachment[]) => void,
): OtioDraftBridge {
  return {
    target(apiBase) {
      const draft = resolve(apiBase)
      return draft ? { key: draft.key, label: draft.label } : null
    },
    add(apiBase, key, review) {
      const draft = resolve(apiBase)
      if (!draft || draft.key !== key || typeof review.text !== 'string' || !review.text.trim()) return false
      const file = review.file
      if (file !== undefined && (!draft.canAttachFiles || typeof File !== 'function' || !(file instanceof File)
        || file.type !== 'image/png' || !/\.png$/i.test(file.name) || !file.size)) return false

      let added: PendingChatAttachment[]
      try {
        // Unlike a file picker, each Add is a separate review. Do not deduplicate by
        // file metadata: different frames can have identical names, sizes and timestamps.
        added = file ? appendChatAttachments([], [file]) : []
      } catch {
        return false
      }
      const reference = added[0] && imageAttachmentReference(added[0])
      const text = `${draft.text ? `${draft.text}\n\n` : ''}${review.text}${reference ? `\n${reference}` : ''}`
      commit(text, [...draft.attachments, ...added])
      return true
    },
  }
}

// Registration follows the conversation controller, not the file view or its
// Teleport destination. A separate workbench can never resolve this map.
type ResolveEditorDraft = (sessionId: string) => OtioDraftBridge | undefined
const editorDrafts = new WeakMap<EditorGroups, Map<string, ResolveEditorDraft>>()

export function registerOtioDraft(groups: EditorGroups, editorId: string, resolve: ResolveEditorDraft): () => void {
  let drafts = editorDrafts.get(groups)
  if (!drafts) editorDrafts.set(groups, drafts = shallowReactive(new Map()))
  drafts.set(editorId, resolve)
  return () => { if (drafts.get(editorId) === resolve) drafts.delete(editorId) }
}

export function createExplorerOtioDraftBridge(
  groups: EditorGroups,
  scope: () => { apiBase: string; projectId: string } | null,
): OtioDraftBridge {
  function resolve(apiBase: string) {
    const source = scope()
    if (!source || apiBase !== source.apiBase) return
    const editor = groups.referenceTarget(source.projectId)
    if (editor?.projectId !== source.projectId || !editor.conversation?.editable) return
    return editorDrafts.get(groups)?.get(editor.id)?.(editor.conversation.sessionId)
  }
  return {
    target: apiBase => resolve(apiBase)?.target(apiBase) ?? null,
    // The owning bridge checks the key and reveals its conversation only after a successful commit.
    add: (apiBase, key, review) => resolve(apiBase)?.add(apiBase, key, review) ?? false,
  }
}
