import { shallowReactive, shallowRef, watch, type InjectionKey, type Ref } from 'vue'
import type { EditorGroups } from './editor-groups.ts'

export type GltfFileOwner =
  | { kind: 'session-workdir' | 'session-files' | 'attachment'; sessionId: string }
  | { kind: 'project-workdir' }
  | { kind: 'folder'; folderId: string }

export type GltfReferenceSource = {
  apiBase: string
  projectId: string
  execution?: { nodeId: string; workdirId: string }
} & (GltfFileOwner | {
  kind: 'archive'
  owner: GltfFileOwner
  archivePath: string
  /** Nested archive paths, outermost first; excludes the final object file. */
  members?: readonly string[]
})

export interface GltfObjectReference {
  assetId: string
  /** Owner-relative file path, or final member path inside the indicated archive. */
  path: string
  buildVersion: string
  objectId: string
  label: string
}

export interface GltfReferenceTarget { key: string; label: string; sessionId: string | null }
/** Reuse the same function for a mounted Viewer. Return true only after registering
 * this exact scope; pass the attempt signal together with the Viewer's lifecycle. */
export type GltfPrepareCapture = (target: Readonly<{
  apiBase: string; projectId: string; sessionId: string; assetId: string; version: string
}>, signal: AbortSignal) => Promise<boolean>

export interface GltfReferenceDraftBridge {
  target(source: GltfReferenceSource): GltfReferenceTarget | null
  /** Call only on explicit Add. False leaves the entire draft unchanged. */
  add(source: GltfReferenceSource, key: string, objects: readonly GltfObjectReference[], prepareCapture?: GltfPrepareCapture): boolean
}
export const GltfReferenceDraftKey: InjectionKey<GltfReferenceDraftBridge> = Symbol('GltfReferenceDraft')

export interface GltfDraftReference {
  readonly key: string
  readonly label: string
  readonly object: Readonly<GltfObjectReference>
  readonly source: Readonly<GltfReferenceSource>
}

// Capabilities are never persisted or serialized with the object reference.
const scratchCapture = new WeakMap<GltfDraftReference, GltfPrepareCapture>()

export async function prepareGltfDraftCapture(
  submitted: readonly GltfDraftReference[],
  current: () => readonly GltfDraftReference[] | null,
  scope: { apiBase: string; projectId: string; sessionId: string },
  signal: AbortSignal,
  budgetMs = 1_500,
): Promise<boolean> {
  const first = submitted[0]
  if (!first || !scope.sessionId.startsWith('web:') || scope.sessionId.length <= 4 || signal.aborted) return false
  const prepare = scratchCapture.get(first)
  const { assetId, path, buildVersion: version } = first.object
  const locator = JSON.stringify(first.source)
  const stillCurrent = () => {
    const live = current()
    return !!live && submitted.every(item => live.includes(item))
  }
  if (!prepare || scope.apiBase !== first.source.apiBase || scope.projectId !== first.source.projectId
    || !stillCurrent() || !submitted.every(item => scratchCapture.get(item) === prepare
      && JSON.stringify(item.source) === locator && item.object.assetId === assetId
      && item.object.path === path && item.object.buildVersion === version)) return false

  const attempt = new AbortController()
  let finish!: (value: boolean) => void
  const cancelled = new Promise<boolean>(resolve => { finish = resolve })
  const cancel = () => { attempt.abort(); finish(false) }
  const timer = setTimeout(cancel, budgetMs)
  signal.addEventListener('abort', cancel, { once: true })
  try {
    const ready = await Promise.race([prepare(Object.freeze({ ...scope, assetId, version }), attempt.signal), cancelled])
    if (ready !== true || attempt.signal.aborted || signal.aborted || !stillCurrent()) { cancel(); return false }
    return true
  } catch {
    cancel()
    return false
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', cancel)
  }
}

function nonempty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\x00-\x1f\x7f]/.test(value)
}

function relativeFilePath(path: unknown): path is string {
  return nonempty(path) && !path.includes('\\') && !/^[a-z][a-z\d+.-]*:/i.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..')
}

export function gltfFileOwner(source: GltfReferenceSource): GltfFileOwner {
  return source.kind === 'archive' ? source.owner : source
}

function snapshotOwner(owner: GltfFileOwner): GltfFileOwner | undefined {
  switch (owner?.kind) {
    case 'session-workdir': case 'session-files': case 'attachment':
      if (nonempty(owner.sessionId)) return { kind: owner.kind, sessionId: owner.sessionId }
      break
    case 'folder':
      if (nonempty(owner.folderId)) return { kind: owner.kind, folderId: owner.folderId }
      break
    case 'project-workdir': return { kind: owner.kind }
  }
}

function snapshotSource(source: GltfReferenceSource): GltfReferenceSource | undefined {
  if (!source || typeof source.apiBase !== 'string' || /[\x00-\x1f\x7f]/.test(source.apiBase) || !nonempty(source.projectId)) return
  const base = { apiBase: source.apiBase, projectId: source.projectId, execution: undefined as GltfReferenceSource['execution'] }
  if (source.execution !== undefined) {
    if (!nonempty(source.execution?.nodeId) || !nonempty(source.execution?.workdirId)) return
    base.execution = Object.freeze({ nodeId: source.execution.nodeId, workdirId: source.execution.workdirId })
  }
  const owner = snapshotOwner(gltfFileOwner(source))
  if (!owner) return
  if (source.kind !== 'archive') return Object.freeze({ ...base, ...owner })
  const members = source.members === undefined ? [] : source.members
  if (!relativeFilePath(source.archivePath) || !Array.isArray(members) || ![...members].every(relativeFilePath)) return
  return Object.freeze({ ...base, kind: source.kind, owner: Object.freeze(owner), archivePath: source.archivePath, members: Object.freeze([...members]) })
}

function compactObjectId(id: string): string {
  const gltfIndex = /^gltf:.*:(\d+):(\d+)$/.exec(id)
  if (gltfIndex) return `gltf:${gltfIndex[1]}:${gltfIndex[2]}`
  return id.length > 32 ? `${id.slice(0, 16)}…${id.slice(-12)}` : id
}

export function gltfReferenceChips(references: readonly GltfDraftReference[]) {
  // Count what the user sees, but never use a display string as chip identity.
  const versions = new Map<string, Set<string>>()
  for (const { label, object } of references) {
    let builds = versions.get(label)
    if (!builds) versions.set(label, builds = new Set())
    builds.add(object.buildVersion)
  }
  const tags = new Map<string, Map<string, string>>()
  for (const [label, builds] of versions) {
    if (builds.size < 2) continue
    const byVersion = new Map<string, string>()
    const byTag = new Map<string, string[]>()
    for (const version of builds) {
      const tag = version.length > 12 ? `…${version.slice(-12)}` : version
      const matches = byTag.get(tag) ?? []
      matches.push(version)
      byTag.set(tag, matches)
    }
    for (const [tag, matches] of byTag) {
      matches.forEach((version, index) => byVersion.set(version, matches.length === 1 ? tag : `${tag} #${index + 1}`))
    }
    tags.set(label, byVersion)
  }
  return references.map(({ key, label, object, source: { apiBase: _apiBase, ...source } }) => {
    const tag = tags.get(label)?.get(object.buildVersion)
    return { key, label: tag ? `${label} · ${tag}` : label, details: JSON.stringify({ ...object, source }, null, 2) }
  })
}

export function createGltfReferenceDraftBridge(
  resolve: (source: GltfReferenceSource) => GltfReferenceTarget | null,
  commit: (references: readonly GltfDraftReference[]) => boolean,
): GltfReferenceDraftBridge {
  function readTarget(source: GltfReferenceSource) {
    const draft = resolve(source)
    if (!draft) return null
    const owner = gltfFileOwner(source)
    if ('sessionId' in owner && owner.sessionId !== draft.sessionId) return null
    return { ...draft, key: JSON.stringify([draft.key, draft.sessionId, source]) }
  }
  return {
    target(source) {
      const snapshot = snapshotSource(source)
      return snapshot ? readTarget(snapshot) : null
    },
    add(source, key, objects, prepareCapture) {
      const snapshot = snapshotSource(source)
      const target = snapshot && readTarget(snapshot)
      if (!snapshot || !target || target.key !== key || !Array.isArray(objects) || !objects.length) return false
      const references: GltfDraftReference[] = []
      for (const object of objects) {
        if (!object) return false
        const { assetId, path, buildVersion, objectId, label } = object
        if (!relativeFilePath(path) || ![assetId, buildVersion, objectId, label].every(nonempty)) return false
        const reference = Object.freeze({
          key: JSON.stringify([snapshot, assetId, path, buildVersion, objectId]),
          label: `${label} · ${compactObjectId(objectId)}`,
          source: snapshot,
          object: Object.freeze({ assetId, path, buildVersion, objectId, label }),
        })
        if (target.sessionId === null && typeof prepareCapture === 'function') scratchCapture.set(reference, prepareCapture)
        references.push(reference)
      }
      return commit(references)
    },
  }
}

/** A snapshot identifies a build; it does not claim the source still matches it. */
export function composeGltfReferenceMessage(text: string, references: readonly GltfDraftReference[]): string {
  if (!references.length) return text
  const lines = references.map(({ source: { apiBase: _apiBase, ...source }, object }) => `  ${JSON.stringify({ source, ...object })}`)
  const heading = 'glTF / Playground object references (selected build snapshots; paths relative to their source owner; archive members and attachments are not workdir files):'
  const block = '```json\n[\n' + lines.join(',\n') + '\n]\n```'
  const capture = 'If capture_view is available for this turn, use mode: current and the exact assetId (and version: buildVersion to require that build). After editing, pass afterVersion: <previous observed version>; retry after the Viewer reloads if it still shows that version.'
  return [text, `${heading}\n\n${block}\n\n${capture}`].filter(Boolean).join('\n\n')
}

export function useGltfReferenceDraft(key: Readonly<Ref<string>>) {
  const items = shallowRef<readonly GltfDraftReference[]>([])
  const drafts = new Map<string, readonly GltfDraftReference[]>()
  let current = key.value
  watch(key, next => {
    if (next === current) return
    if (items.value.length) drafts.set(current, items.value)
    current = next
    items.value = drafts.get(next) ?? []
    drafts.delete(next)
  }, { flush: 'sync' })
  function remove(target: string, keys?: ReadonlySet<string>) {
    const references = target === current ? items.value : drafts.get(target) ?? []
    const remaining = keys ? references.filter(item => !keys.has(item.key)) : []
    if (target === current) items.value = remaining
    else if (remaining.length) drafts.set(target, remaining)
    else drafts.delete(target)
  }
  return {
    items: items as Readonly<typeof items>,
    append(references: readonly GltfDraftReference[]) {
      const keys = new Set(items.value.map(item => item.key))
      const added = references.filter(item => {
        if (keys.has(item.key)) return false
        keys.add(item.key)
        return true
      })
      if (!added.length) return false
      items.value = [...items.value, ...added]
      return true
    },
    migrate(next: string) {
      if (next === current) return
      drafts.delete(next)
      current = next
    },
    remove,
    dispose() { drafts.clear(); items.value = [] },
  }
}

// The EditorGroups instance isolates workbenches, including ones on the same Main.
type ResolveEditorDraft = (sessionId: string) => GltfReferenceDraftBridge | undefined
const editorDrafts = new WeakMap<EditorGroups, Map<string, ResolveEditorDraft>>()

export function registerGltfReferenceDraft(groups: EditorGroups, editorId: string, resolve: ResolveEditorDraft): () => void {
  let drafts = editorDrafts.get(groups)
  if (!drafts) editorDrafts.set(groups, drafts = shallowReactive(new Map()))
  drafts.set(editorId, resolve)
  return () => { if (drafts.get(editorId) === resolve) drafts.delete(editorId) }
}

export function createExplorerGltfReferenceDraftBridge(
  groups: EditorGroups,
  scope?: () => { apiBase: string; projectId: string } | null,
): GltfReferenceDraftBridge {
  function resolve(source: GltfReferenceSource) {
    if (!nonempty(source?.projectId)) return
    const allowed = scope?.()
    if (scope && (!allowed || allowed.apiBase !== source.apiBase || allowed.projectId !== source.projectId)) return
    const editor = groups.referenceTarget(source.projectId)
    if (editor?.projectId !== source.projectId || !editor.conversation?.editable) return
    return editorDrafts.get(groups)?.get(editor.id)?.(editor.conversation.sessionId)
  }
  return {
    target: source => resolve(source)?.target(source) ?? null,
    add: (source, key, objects, prepareCapture) => resolve(source)?.add(source, key, objects, prepareCapture) ?? false,
  }
}
