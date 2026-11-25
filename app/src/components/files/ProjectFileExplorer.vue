<template>
  <aside v-show="open" :id="explorerId" class="project-file-explorer" :style="{ '--file-explorer-width': `${explorerWidth}px` }" :aria-label="t('File explorer')" @keydown.esc.stop.prevent="emit('close')">
    <SidebarResizer v-if="active && open && !mobile?.enabled.value && resizeBounds.max > resizeBounds.min"
      class="file-explorer-resizer" :model-value="explorerWidth" :bounds="resizeBounds"
      :label="t('Resize files')" :controls="explorerId" @update:model-value="preferredWidth = $event" />
    <ProjectExplorerRoot v-if="sessionId" :key="`session:${sessionId}`" :root-id="`session:${sessionId}`" :api-base="apiBase" :session-id="sessionId" :label="t('Session files')" :hint="`${t('Session files')}: ${sessionEditor?.label}`" :reveal="active && open && !sessionEditor?.conversation?.folderId && !preferredFolderId" :active="active && open" @open="openFile" />
    <p v-if="!sessionId && !relatedFolders.length && !error" class="catalog-empty">{{ t('Choose a workspace in navigation or start a conversation to browse its files.') }}</p>
    <p v-if="error" class="catalog-error" role="alert">{{ error }} <button @click="load">{{ t('Retry folders') }}</button></p>
    <ProjectExplorerRoot v-for="folder in relatedFolders" :key="`folder:${folder.id}`" :root-id="`folder:${folder.id}`" :api-base="apiBase" session-id="" :folder="folder" :label="folder.name" :source="folderSource(folder)" :hint="folderHint(folder)" :reveal="active && open && folder.id === preferredFolderId" :active="active && open" @open="openFile" />
    <GltfOutlineDock v-if="active && open" :project-id="projectId" />
    <div ref="outlineHost" class="outline-host" />
  </aside>
  <EditorViewHost v-for="file in files" :key="fileTabKey(file)" :descriptor="descriptor(file)" :active="active">
    <ProjectExplorerFile :api-base="apiBase" :file="file" :outline-target="desktopOutlineHost && groups.active(projectId)?.id === editorId(file) ? desktopOutlineHost : undefined"
      :outline-in-background="!!desktopOutlineHost && groups.active(projectId)?.id !== editorId(file)" :can-quote="canQuote" @quote="emit('quote', $event)" :active="active && groups.visible(editorId(file))" @open="openFile" @close="close(file)" />
  </EditorViewHost>
</template>
<script setup lang="ts">
import GltfOutlineDock from './GltfOutlineDock.vue'
import { computed, inject, onUnmounted, ref, watch } from 'vue'
import { useMobileChrome } from '../../composables/useMobileChrome.ts'
import { EditorGroupsKey, type EditorDescriptor } from '../../editor-groups.ts'
import { createFoldersClient, type FolderRecord } from '../../folders-client.ts'
import { fileTabKey, type OpenFile } from '../../file-workbench.ts'
import { t } from '../../i18n.ts'
import { useLiveClientPool } from '../../composables/useLiveClient.ts'
import { createLiveResourceRefresh } from '../../live-resource-refresh.ts'
import EditorViewHost from '../EditorViewHost.vue'
import SidebarResizer from '../SidebarResizer.vue'
import { clampSidebarWidth, sidebarWidthBounds } from '../../sidebar-resize.ts'
import ProjectExplorerRoot from './ProjectExplorerRoot.vue'
import ProjectExplorerFile from './ProjectExplorerFile.vue'
const props = defineProps<{ apiBase: string; projectId: string; active: boolean; open: boolean; explorerId: string; containerWidth: number; folderRevision?: number; canQuote?: boolean }>()
const emit = defineEmits<{ close: []; quote: [text: string] }>()
const groups = inject(EditorGroupsKey)!
const mobile = useMobileChrome()
const preferredWidth = ref(240)
const resizeBounds = computed(() => sidebarWidthBounds(props.containerWidth, 180, 400))
const explorerWidth = computed(() => clampSidebarWidth(preferredWidth.value, resizeBounds.value))
const outlineHost = ref<HTMLElement>()
const desktopOutlineHost = computed(() => props.active && props.open && !mobile?.enabled.value ? outlineHost.value : undefined)
const conversations = computed(() => {
  const state = groups.state(props.projectId)
  return [...state.left, ...state.right].flatMap(id => {
    const editor = groups.descriptors.get(id)
    return editor?.conversation ? [editor] : []
  })
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
const sessionEditor = computed(() => {
  const editor = groups.active(props.projectId)
  if (editor?.owner !== `${props.projectId}:explorer`) return editor
  // Keep the source session available while browsing its files, even if read-only.
  const source = files.value.find(file => editorId(file) === editor.id)?.source
  return source?.sessionWorkspace
    ? conversations.value.find(item => item.conversation?.sessionId === source.sessionId)
    : groups.referenceTarget(props.projectId)
})
const sessionId = computed(() => sessionEditor.value?.conversation?.sessionId)
const preferredFolderId = computed(() => {
  const boundId = sessionEditor.value?.conversation?.folderId
  const boundFolder = folders.value.find(folder => folder.id === boundId)
  const identity = boundFolder && resourceIdentity(boundFolder)
  return (relatedFolders.value.find(folder => resourceIdentity(folder) === identity) ?? relatedFolders.value[0])?.id
})
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
  if (mobile?.enabled.value) emit('close')
}
</script>
<style scoped>
.project-file-explorer { position: relative; display: flex; flex-direction: column; width: var(--file-explorer-width); flex: 0 0 var(--file-explorer-width); box-sizing: border-box; min-width: 0; min-height: 0; overflow: hidden; border-right: 1px solid var(--c-border); background: var(--c-bg-soft); }
/* Keep the entire hit target inside the clipped file tree. */
.project-file-explorer > .file-explorer-resizer { right: 0; }
.project-file-explorer > .file-explorer-resizer::after { left: auto; right: 0; }
.outline-host { display: contents; }
.catalog-error { padding: 8px; color: var(--c-error); font-size: 12px; }
.catalog-empty { padding: 16px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
@media (max-width: 700px) { .project-file-explorer { width: min(240px, 60vw); flex-basis: min(240px, 60vw); } .project-file-explorer > .file-explorer-resizer { display: none; } }
</style>
