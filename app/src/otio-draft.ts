import { shallowReactive, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
import type { EditorGroups } from './editor-groups.ts'
import { appendChatAttachments, imageAttachmentReference, revokeChatAttachmentPreviews, type PendingChatAttachment } from './chat-attachments.ts'
import { createUuid } from './uuid.ts'

export interface OtioReview { label: string; text: string; file?: File }
export interface OtioDraftReference {
  key: string
  label: string
  text: string
  attachment?: PendingChatAttachment
}

/** References are resolved into message content only at submission. */
export function composeOtioReferenceMessage(text: string, references: readonly OtioDraftReference[]): string {
  return [text, ...references.map(reference => reference.attachment
    ? `${reference.text}\n${imageAttachmentReference(reference.attachment)}`
    : reference.text)].filter(Boolean).join('\n\n')
}
export interface OtioDraftBridge {
  target(apiBase: string): { key: string; label: string } | null
  add(apiBase: string, key: string, review: OtioReview): boolean
  canStart?(apiBase: string): boolean
  start?(apiBase: string, review: OtioReview, signal: AbortSignal): Promise<boolean>
}
export const OtioDraftKey: InjectionKey<OtioDraftBridge> = Symbol('OtioDraft')

interface ReviewDraft {
  key: string
  label: string
  canAttachFiles: boolean
}

/** Resolve and stage synchronously so a rejected review cannot change the draft. */
export function createOtioDraftBridge(
  resolve: (apiBase: string) => ReviewDraft | null,
  commit: (reference: OtioDraftReference) => void,
): OtioDraftBridge {
  return {
    target(apiBase) {
      const draft = resolve(apiBase)
      return draft ? { key: draft.key, label: draft.label } : null
    },
    add(apiBase, key, review) {
      const draft = resolve(apiBase)
      if (!draft || draft.key !== key) return false
      const reference = prepareOtioReference(review, draft.canAttachFiles)
      if (!reference) return false
      commit(reference)
      return true
    },
  }
}

export function prepareOtioReference(review: OtioReview, canAttachFiles: boolean): OtioDraftReference | undefined {
  if (typeof review.text !== 'string' || !review.text.trim() || typeof review.label !== 'string' || !review.label.trim()) return
  const file = review.file
  if (file !== undefined && (!canAttachFiles || typeof File !== 'function' || !(file instanceof File)
    || file.type !== 'image/png' || !/\.png$/i.test(file.name) || !file.size)) return
  const reference: OtioDraftReference = { key: createUuid(), label: review.label.trim(), text: review.text }
  try {
    // Each intentional Add is a separate review, even if PNG metadata matches.
    if (file) reference.attachment = appendChatAttachments([], [file])[0]!
    return reference
  } catch { return }
}

export interface OtioFileScope {
  apiBase: string
  projectId: string
  folderId?: string
  sessionId?: string
}
export interface OtioDraftOpener {
  available(scope: OtioFileScope): boolean
  start(scope: OtioFileScope, review: OtioReview, signal: AbortSignal): Promise<boolean>
}
export const OtioStartDraftKey: InjectionKey<OtioDraftOpener> = Symbol('OtioStartDraft')

/** Like other context chips, references are kept per composer for the life of its controller. */
export function useOtioReferenceDraft(key: Readonly<Ref<string>>) {
  const items = shallowRef<OtioDraftReference[]>([])
  const drafts = new Map<string, OtioDraftReference[]>()
  let current = key.value
  watch(key, next => {
    if (next === current) return
    if (items.value.length) drafts.set(current, items.value)
    current = next
    items.value = drafts.get(next) ?? []
    drafts.delete(next)
  }, { flush: 'sync' })
  function discard(references: readonly OtioDraftReference[]) {
    revokeChatAttachmentPreviews(references.flatMap(item => item.attachment ? [item.attachment] : []))
  }
  function remove(target: string, keys?: ReadonlySet<string>) {
    const references = target === current ? items.value : drafts.get(target) ?? []
    discard(keys ? references.filter(item => keys.has(item.key)) : references)
    const remaining = keys ? references.filter(item => !keys.has(item.key)) : []
    if (target === current) items.value = remaining
    else if (remaining.length) drafts.set(target, remaining)
    else drafts.delete(target)
  }
  return {
    items,
    append: (item: OtioDraftReference) => { items.value = [...items.value, item] },
    migrate(next: string) {
      if (next === current) return
      discard(drafts.get(next) ?? [])
      drafts.delete(next)
      current = next
    },
    remove,
    dispose() {
      discard(items.value)
      for (const references of drafts.values()) discard(references)
      drafts.clear()
      items.value = []
    },
  }
}

// Registration follows the conversation controller, not the file view or its
// Teleport destination. A separate workbench can never resolve this map.
type ResolveEditorDraft = (sessionId: string, source?: OtioFileScope) => OtioDraftBridge | undefined
const editorDrafts = new WeakMap<EditorGroups, Map<string, ResolveEditorDraft>>()

export function registerOtioDraft(groups: EditorGroups, editorId: string, resolve: ResolveEditorDraft): () => void {
  let drafts = editorDrafts.get(groups)
  if (!drafts) editorDrafts.set(groups, drafts = shallowReactive(new Map()))
  drafts.set(editorId, resolve)
  return () => { if (drafts.get(editorId) === resolve) drafts.delete(editorId) }
}

export function createExplorerOtioDraftBridge(
  groups: EditorGroups,
  scope: () => OtioFileScope | null,
  opener?: OtioDraftOpener,
): OtioDraftBridge {
  function resolve(apiBase: string) {
    const source = scope()
    if (!source || apiBase !== source.apiBase) return
    const state = groups.state(source.projectId)
    const candidates = new Set([state.selected[state.active], state.selected[state.active === 'left' ? 'right' : 'left'], groups.referenceTarget(source.projectId)?.id])
    for (const id of candidates) {
      const editor = id ? groups.descriptors.get(id) : undefined
      if (editor?.projectId !== source.projectId || !editor.conversation?.editable) continue
      if (source.folderId ? editor.conversation.folderId !== source.folderId
        : source.sessionId && editor.conversation.sessionId !== source.sessionId) continue
      const bridge = editorDrafts.get(groups)?.get(editor.id)?.(editor.conversation.sessionId, source)
      if (bridge?.target(apiBase)) return bridge
    }
  }
  function localScope(apiBase: string) {
    const source = scope()
    return source?.apiBase === apiBase && opener?.available(source) ? source : undefined
  }
  return {
    target: apiBase => resolve(apiBase)?.target(apiBase) ?? null,
    add: (apiBase, key, review) => resolve(apiBase)?.add(apiBase, key, review) ?? false,
    canStart: apiBase => !!localScope(apiBase),
    async start(apiBase, review, signal) {
      const source = localScope(apiBase)
      return source && !signal.aborted ? await opener!.start(source, review, signal) : false
    },
  }
}
