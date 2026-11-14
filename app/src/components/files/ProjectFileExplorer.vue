<template>
  <aside v-show="open" :id="explorerId" class="project-file-explorer" :aria-label="t('File explorer')" @keydown.esc.stop.prevent="emit('close')">
    <ProjectExplorerRoot v-for="session in sessions" :key="`session:${session.sessionId}`" :root-id="`session:${session.sessionId}`" :api-base="apiBase" :session-id="session.sessionId" :label="`${t('Session files')}: ${session.label}`" :active="active && open" @open="openFile" />
    <p v-if="error" class="catalog-error" role="alert">{{ error }} <button @click="load">{{ t('Retry folders') }}</button></p>
    <ProjectExplorerRoot v-for="folder in folders" :key="`folder:${folder.id}`" :root-id="`folder:${folder.id}`" :api-base="apiBase" session-id="" :folder="folder" :label="folderLabel(folder)" :active="active && open" @open="openFile" />
  </aside>
  <EditorViewHost v-for="file in files" :key="fileTabKey(file)" :descriptor="descriptor(file)" :active="active">
    <ProjectExplorerFile :api-base="apiBase" :file="file" :can-quote="canQuote" @quote="emit('quote', $event)" :active="active && groups.visible(editorId(file))" @open="openFile" @close="close(file)" />
  </EditorViewHost>
</template>
<script setup lang="ts">
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { EditorGroupsKey, type EditorDescriptor } from '../../editor-groups.ts'
import { createFoldersClient, type FolderRecord } from '../../folders-client.ts'
import { fileTabKey, type OpenFile } from '../../file-workbench.ts'
import { t } from '../../i18n.ts'
import { useLiveClientPool } from '../../composables/useLiveClient.ts'
import { createLiveResourceRefresh } from '../../live-resource-refresh.ts'
import EditorViewHost from '../EditorViewHost.vue'
import ProjectExplorerRoot from './ProjectExplorerRoot.vue'
import ProjectExplorerFile from './ProjectExplorerFile.vue'
const props = defineProps<{ apiBase: string; projectId: string; active: boolean; open: boolean; explorerId: string; folderRevision?: number; canQuote?: boolean }>()
const emit = defineEmits<{ close: []; quote: [text: string] }>()
const groups = inject(EditorGroupsKey)!
const sessions = computed(() => {
  const state = groups.state(props.projectId)
  const unique = new Map<string, { sessionId: string; label: string }>()
  for (const id of [...state.left, ...state.right]) {
    const editor = groups.descriptors.get(id)
    if (editor?.conversation?.sessionId) unique.set(editor.conversation.sessionId, { sessionId: editor.conversation.sessionId, label: editor.label })
  }
  return [...unique.values()]
})
const livePool = useLiveClientPool()
const folders = ref<FolderRecord[]>([]), error = ref('')
// Local catalog IDs are canonical resource identities. Remote aliases may have
// different catalog IDs but refer to the same physical root on the same node.
function resourceIdentity(folder: FolderRecord) {
  return folder.kind === 'remote'
    ? JSON.stringify(['remote', folder.workdir.nodeId, folder.identity.rootId])
    : JSON.stringify([folder.kind ?? 'local', folder.id])
}
function folderLabel(folder: FolderRecord) {
  const label = `${t('Project files')}: ${folder.name}`
  if (folders.value.filter(item => item.name === folder.name).length < 2) return label
  // Paths here are public display metadata only, never resolved on Main.
  const location = folder.kind === 'remote' ? folder.workdir.nodeId : folder.kind === 'layerfs' ? 'LayerFS' : t('Main')
  return `${label} — ${location}: ${folder.path}`
}
let controller: AbortController | undefined
async function load() {
  controller?.abort()
  const request = new AbortController(); controller = request
  try {
    const next = await createFoldersClient(props.apiBase).list(request.signal)
    if (!request.signal.aborted) {
      const seen = new Set<string>()
      folders.value = next.filter(folder => {
        const identity = resourceIdentity(folder)
        if (seen.has(identity)) return false
        seen.add(identity)
        return true
      })
      error.value = ''
    }
  } catch (cause) { if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Retry folders') }
}
watch(() => [props.active, props.folderRevision, props.apiBase, props.open], () => { if (props.active) void load() }, { immediate: true })
let catalog: ReturnType<typeof createLiveResourceRefresh> | undefined
watch(() => [props.active, props.apiBase, props.projectId] as const, () => {
  catalog?.dispose()
  catalog = props.active ? createLiveResourceRefresh(livePool, { base: props.apiBase, projectId: props.projectId, resource: 'folders', refresh: () => { void load() } }) : undefined
  if (!props.active) controller?.abort()
}, { immediate: true })
onUnmounted(() => { catalog?.dispose(); controller?.abort() })
const files = ref<OpenFile[]>([])
function editorId(file: OpenFile) { return JSON.stringify([props.projectId, 'explorer-file', fileTabKey(file)]) }
function close(file: OpenFile) { descriptors.delete(editorId(file)); files.value = files.value.filter(item => fileTabKey(item) !== fileTabKey(file)) }
const descriptors = new Map<string, EditorDescriptor>()
function descriptor(file: OpenFile): EditorDescriptor {
  const id = editorId(file)
  if (!descriptors.has(id)) descriptors.set(id, { id, projectId: props.projectId, owner: `${props.projectId}:explorer`, label: file.entry.name, icon: file.view === 'diff' ? 'i-lucide-file-diff' : 'i-lucide-file', closable: true, select() {}, close: () => close(file), commands: { toggleExplorer: () => groups.toggleExplorer(props.projectId) } })
  return descriptors.get(id)!
}
function openFile(file: OpenFile) {
  if (!file.source?.folderId && !(file.source?.sessionWorkspace && file.source.sessionId)) return
  if (!files.value.some(item => fileTabKey(item) === fileTabKey(file))) files.value.push(file)
  groups.open(descriptor(file), groups.state(props.projectId).active)
}
</script>
<style scoped>
.project-file-explorer { width: 240px; flex: 0 0 240px; min-height: 0; overflow: auto; border-right: 1px solid var(--c-border); background: var(--c-bg-soft); }
.catalog-error { padding: 8px; color: var(--c-error); font-size: 12px; }
@media (max-width: 700px) { .project-file-explorer { width: min(240px, 60vw); flex-basis: min(240px, 60vw); } }
</style>
