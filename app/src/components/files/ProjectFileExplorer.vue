<template>
  <aside v-show="open" :id="explorerId" class="project-file-explorer" :aria-label="t('File explorer')" @keydown.esc.stop.prevent="emit('close')">
    <ProjectExplorerRoot v-for="session in sessions" :key="`session:${session.sessionId}`" :root-id="`session:${session.sessionId}`" :api-base="apiBase" :session-id="session.sessionId" :label="session.label" :hint="`${t('Session files')}: ${session.label}`" :active="active && open" @open="openFile" />
    <p v-if="error" class="catalog-error" role="alert">{{ error }} <button @click="load">{{ t('Retry folders') }}</button></p>
    <ProjectExplorerRoot v-for="folder in relatedFolders" :key="`folder:${folder.id}`" :root-id="`folder:${folder.id}`" :api-base="apiBase" session-id="" :folder="folder" :label="folder.name" :source="folderSource(folder)" :hint="folderHint(folder)" :active="active && open" @open="openFile" />
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
const conversations = computed(() => {
  const state = groups.state(props.projectId)
  return [...state.left, ...state.right].flatMap(id => {
    const editor = groups.descriptors.get(id)
    return editor?.conversation?.sessionId ? [editor] : []
  })
})
const sessions = computed(() => {
  const unique = new Map<string, { sessionId: string; label: string }>()
  for (const editor of conversations.value) {
    const sessionId = editor.conversation!.sessionId
    unique.set(sessionId, { sessionId, label: editor.label })
  }
  return [...unique.values()]
})
const livePool = useLiveClientPool()
const folders = ref<FolderRecord[]>([]), error = ref('')
const relatedFolders = computed(() => {
  const bound = new Set(conversations.value.map(editor => editor.conversation?.folderId).filter(Boolean))
  const seen = new Set<string>()
  return folders.value.filter(folder => {
    if (!bound.has(folder.id)) return false
    const identity = resourceIdentity(folder)
    if (seen.has(identity)) return false
    seen.add(identity)
    return true
  })
})
// Local catalog IDs are canonical resource identities. Remote aliases may have
// different catalog IDs but refer to the same physical root on the same node.
function resourceIdentity(folder: FolderRecord) {
  return folder.kind === 'remote'
    ? JSON.stringify(['remote', folder.workdir.nodeId, folder.identity.rootId])
    : JSON.stringify([folder.kind ?? 'local', folder.id])
}
const devices = ref<Record<string, string>>({})
const mainDeviceName = ref('')
function folderSource(folder: FolderRecord) {
  if (folder.kind === 'layerfs') return 'LayerFS'
  if (folder.kind !== 'remote') return mainDeviceName.value || t('Main')
  const node = folder.workdir.nodeId
  const name = devices.value[node]
  if (!name) return node.slice(0, 8)
  const duplicate = Object.values(devices.value).filter(value => value === name).length > 1
  return duplicate ? `${name} · ${node.slice(0, 6)}` : name
}
function folderHint(folder: FolderRecord) {
  const node = folder.kind === 'remote' ? ` (${folder.workdir.nodeId})` : ''
  return `${t('Project files')}: ${folder.name} — ${folderSource(folder)}${node}\n${folder.path}`
}
let controller: AbortController | undefined
async function load() {
  controller?.abort()
  const request = new AbortController(); controller = request
  try {
    const client = createFoldersClient(props.apiBase)
    // Friendly device metadata is optional; catalog availability must not depend on it.
    const [next, deviceList] = await Promise.all([client.list(request.signal), client.pickerDevices(request.signal).catch(() => [])])
    if (!request.signal.aborted) {
      devices.value = Object.fromEntries(deviceList.map(device => [device.nodeId, device.name.trim()]))
      mainDeviceName.value = deviceList.find(device => device.role === 'main')?.name.trim() ?? ''
    }
    if (!request.signal.aborted) {
      // Filter by exact catalog bindings before physical-root deduplication:
      // an unbound alias must never hide a bound remote catalog ID.
      folders.value = next
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
.project-file-explorer { display: flex; flex-direction: column; width: 240px; flex: 0 0 240px; min-width: 0; min-height: 0; overflow: hidden; border-right: 1px solid var(--c-border); background: var(--c-bg-soft); }
.catalog-error { padding: 8px; color: var(--c-error); font-size: 12px; }
@media (max-width: 700px) { .project-file-explorer { width: min(240px, 60vw); flex-basis: min(240px, 60vw); } }
</style>
