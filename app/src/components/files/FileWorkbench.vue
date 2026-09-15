<template>
  <div ref="root" class="file-workbench" :class="{ 'explorer-docked': expanded && wide }" :style="{ '--explorer-width': `${explorerWidth}px` }">
    <button v-if="expanded && !wide" class="explorer-backdrop" aria-label="Dismiss files" @click="collapseExplorer" />
    <aside v-if="explorerAvailable" v-show="expanded" :id="`${id}-explorer`" class="workbench-explorer" :class="{ drawer: !wide }" aria-label="File explorer" @keydown.esc.stop.prevent="collapseExplorer">
      <FileTree :api-base="apiBase" :session-id="sessionId" :project-id="projectId" tree-only :active="active && expanded"
        :remote="remote"
        :git-status="gitStatus" :git-loading="gitLoading" :git-error="gitError" @refresh-git="refreshGit" @open="openFile">
        <template #actions>
          <HoverInfo text="Collapse files" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="workbench-button" aria-label="Collapse files" @click="collapseExplorer"><span class="i-lucide-panel-left-close" aria-hidden="true" /></button></HoverInfo>
        </template>
      </FileTree>
      <SidebarResizer v-if="expanded && wide && active" class="files-resizer" :model-value="explorerWidth" :bounds="resizeBounds"
        label="Resize files" :controls="`${id}-explorer`" @update:model-value="preferredWidth = $event" />
    </aside>
    <div class="workbench-editor">
      <div class="document-toolbar">
        <HoverInfo v-if="explorerAvailable" text="Toggle files" v-slot="{ triggerProps }">
        <button v-bind="triggerProps" ref="explorerButton" class="workbench-button explorer-toggle" aria-label="Toggle files" :aria-controls="`${id}-explorer`" :aria-expanded="expanded" @click="toggleExplorer">
          <span class="i-lucide-panel-left" aria-hidden="true" />
        </button>
        </HoverInfo>
        <div class="document-tablist" role="tablist" aria-label="Open documents" @wheel="scrollTabs">
          <div class="document-tab conversation-tab" :class="{ selected: tabs.selected === '' }" @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, '')">
            <button :id="tabId('')" role="tab" :aria-selected="tabs.selected === ''" :tabindex="tabs.selected === '' ? 0 : -1" :aria-controls="panelId('')" @click="selectTab('')" @keydown="tabKey($event, '')">
              <span class="document-icon i-lucide-messages-square" aria-hidden="true" /><span>Conversation</span>
            </button>
          </div>
          <div ref="documentTabs" class="document-tabs">
          <div v-for="file in tabs.files" :key="fileTabKey(file)" class="document-tab" :class="{ selected: tabs.selected === fileTabKey(file) }" @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, fileTabKey(file))">
            <HoverInfo :text="`${file.path}${file.view === 'diff' ? '\nChanges from HEAD' : ''}`" v-slot="{ triggerProps }">
            <button v-bind="triggerProps" :id="tabId(fileTabKey(file))" role="tab" :aria-selected="tabs.selected === fileTabKey(file)" :tabindex="tabs.selected === fileTabKey(file) ? 0 : -1" :aria-controls="panelId(fileTabKey(file))" :aria-label="`${file.path}${file.view === 'diff' ? ' changes' : ''}`" @click="selectTab(fileTabKey(file))" @keydown="tabKey($event, fileTabKey(file))">
              <span class="document-icon" :class="file.view === 'diff' ? 'i-lucide-file-diff' : 'i-lucide-file'" aria-hidden="true" /><span class="document-name">{{ file.entry.name }}{{ file.view === 'diff' ? ' (changes)' : '' }}</span>
            </button>
            </HoverInfo>
            <HoverInfo :text="`Close ${file.entry.name}${file.view === 'diff' ? ' changes' : ''}`" v-slot="{ triggerProps }">
            <button v-bind="triggerProps" class="document-close" :aria-label="`Close ${file.path}${file.view === 'diff' ? ' changes' : ''}`" @click="closeFile(fileTabKey(file))"><span class="i-lucide-x" aria-hidden="true" /></button>
            </HoverInfo>
          </div>
          </div>
        </div>
        <slot name="actions" />
      </div>
      <div class="workbench-content" :class="{ 'draft-document': draft && tabs.selected === '' }">
        <div v-show="tabs.selected === ''" :id="panelId('')" class="conversation-document" role="tabpanel" :aria-labelledby="tabId('')">
          <slot />
        </div>
        <div v-for="file in tabs.files" v-show="tabs.selected === fileTabKey(file)" :id="panelId(fileTabKey(file))" :key="`${contextKey}:${fileTabKey(file)}`" class="file-document" role="tabpanel" :aria-labelledby="tabId(fileTabKey(file))">
          <FileDiffPreview v-if="(sessionId || projectId) && file.view === 'diff'" :api-base="apiBase" :session-id="sessionId" :project-id="projectId"
            :path="file.path" :active="active && tabs.selected === fileTabKey(file)" :selection-active="keyboardActive && tabs.selected === fileTabKey(file)"
            :can-quote="canQuote" :revision="gitRevision" @quote="emit('quote', $event)" @open-source="openFile({ path: file.path, entry: file.entry })" />
          <FilePreviewModal v-else-if="sessionId || projectId" inline :api-base="apiBase" :session-id="sessionId" :project-id="projectId"
            :context-key="contextKey" @image-context="emit('image-context', $event)" @image-busy="emit('image-busy', $event)"
            :active="active && tabs.selected === fileTabKey(file)" :selection-active="keyboardActive && tabs.selected === fileTabKey(file)" :can-quote="canQuote"
            :entry="file.entry" :dir="file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''"
            @quote="emit('quote', $event)" @close="closeFile(fileTabKey(file))" />
        </div>
        <slot name="composer" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import FileTree from './FileTree.vue'
import FilePreviewModal from './FilePreviewModal.vue'
import FileDiffPreview from './FileDiffPreview.vue'
import HoverInfo from '../HoverInfo.vue'
import { useWorkdirGit } from '../../composables/useWorkdirGit.ts'
import SidebarResizer from '../SidebarResizer.vue'
import type { ImageContextBusy, ImageContextUpdate } from '../../image-context.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../../sidebar-resize.ts'
import { closeFileTab, cycleDocumentTab, documentTabDirection, documentTabScrollLeft, fileTabKey, isCloseDocumentKey, nextDocumentTab, openFileTab, selectedFileToClose, type DocumentTabDirection, type FileTabs, type OpenFile } from '../../file-workbench.ts'

const props = withDefaults(defineProps<{ apiBase: string; sessionId: string; projectId?: string; contextKey: string; active: boolean; keyboardActive?: boolean; explorerEnabled?: boolean; draft?: boolean; canQuote?: boolean; remote?: boolean }>(), { keyboardActive: true, explorerEnabled: true, draft: false, canQuote: false, remote: false })
const emit = defineEmits<{ 'conversation-visible': [visible: boolean]; quote: [text: string]; 'image-context': [update: ImageContextUpdate]; 'image-busy': [update: ImageContextBusy] }>()
const id = `documents-${useId().replace(/[^a-zA-Z0-9_-]/g, '')}`
const root = ref<HTMLElement>()
const documentTabs = ref<HTMLElement>()
const explorerButton = ref<HTMLButtonElement>()
const width = ref(0)
const preferredWidth = ref(220)
const resizeBounds = computed(() => sidebarWidthBounds(width.value, 180, 360))
const explorerWidth = computed(() => clampSidebarWidth(preferredWidth.value, resizeBounds.value))
const wide = computed(() => width.value >= 760)
const preference = ref<boolean>()
const remoteExpanded = ref(false)
const explorerAvailable = computed(() => props.explorerEnabled && !!(props.sessionId || props.projectId))
const expanded = computed(() => explorerAvailable.value && (props.remote ? remoteExpanded.value : (preference.value ?? wide.value)))
const tabs = ref<FileTabs>({ files: [], selected: '' })
const gitActive = computed(() => explorerAvailable.value && props.active && (expanded.value || tabs.value.files.some(file => file.view === 'diff' && fileTabKey(file) === tabs.value.selected)))
const { status: gitStatus, loading: gitLoading, error: gitError, revision: gitRevision, refresh: refreshGit } = useWorkdirGit(
  () => ({ apiBase: props.apiBase, sessionId: props.sessionId, projectId: props.projectId }), gitActive)
const cachedTabs = new Map<string, FileTabs>()
let observer: ResizeObserver | undefined
let composing = false
const tabId = (path: string) => `${id}-tab-${encodeURIComponent(path)}`
const panelId = (path: string) => `${id}-panel-${encodeURIComponent(path)}`
function selectTab(path: string) {
  if (tabs.value.selected === path) return
  tabs.value = { ...tabs.value, selected: path }
}
defineExpose({ showConversation: () => selectTab('') })
function openFile(file: OpenFile) {
  tabs.value = openFileTab(tabs.value, file)
  if (!wide.value) { preference.value = false; remoteExpanded.value = false }
  void nextTick(() => {
    const tab = document.getElementById(tabId(fileTabKey(file)))
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function closeFile(path: string, focusSelected = true) {
  tabs.value = closeFileTab(tabs.value, path)
  if (focusSelected) void nextTick(() => document.getElementById(tabId(tabs.value.selected))?.focus({ preventScroll: true }))
}
function preventMiddleScroll(event: MouseEvent) {
  if (event.button === 1) event.preventDefault()
}
function middleClickTab(event: MouseEvent, path: string) {
  if (event.button !== 1) return
  event.preventDefault()
  if (path) closeFile(path, tabs.value.selected === path)
}
function scrollTabs(event: WheelEvent) {
  const strip = documentTabs.value
  if (!strip) return
  const next = documentTabScrollLeft(event, strip)
  if (next === undefined) return
  event.preventDefault()
  strip.scrollLeft = next
}
function tabKey(event: KeyboardEvent, path: string) {
  if (event.key === 'Delete' && path) { event.preventDefault(); closeFile(path); return }
  const next = nextDocumentTab(['', ...tabs.value.files.map(fileTabKey)], path, event.key)
  if (next === undefined) return
  event.preventDefault()
  selectTab(next)
  void nextTick(() => {
    const tab = document.getElementById(tabId(next))
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}
function shortcutContext() {
  const overlayOpen = Array.from(document.querySelectorAll<HTMLElement>(
    '[role="dialog"], [role="menu"], dialog[open], [popover]:popover-open, .project-dialog-backdrop, .project-menu-backdrop, .composer-popover-backdrop',
  )).some(element => element.getClientRects().length > 0
    && (!element.classList.contains('hover-info-popup') || element.contains(document.activeElement)))
  return {
    active: props.active,
    keyboardActive: props.keyboardActive,
    visible: !!root.value?.getClientRects().length,
    explorerEnabled: props.explorerEnabled,
    overlayOpen,
    composing,
  }
}
function closeCurrentFile(): boolean {
  const key = selectedFileToClose(tabs.value, shortcutContext())
  if (key === undefined) return false
  closeFile(key)
  return true
}
function cycleTab(direction: DocumentTabDirection): boolean {
  const next = cycleDocumentTab(tabs.value, direction, shortcutContext())
  if (next === undefined) return false
  selectTab(next)
  void nextTick(() => {
    const tab = document.getElementById(tabId(next))
    tab?.focus({ preventScroll: true })
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
  return true
}
function documentKey(event: KeyboardEvent) {
  if (isCloseDocumentKey(event) && closeCurrentFile()) {
    event.preventDefault()
    event.stopPropagation()
    return
  }
  const direction = documentTabDirection(event)
  if (direction === undefined || !cycleTab(direction)) return
  event.preventDefault()
  event.stopPropagation()
}
function nativeDocumentKey(event: Event) {
  const direction: unknown = (event as CustomEvent).detail
  if (direction === 'close') closeCurrentFile()
  else if (direction === -1 || direction === 1) cycleTab(direction)
}
function compositionStart() { composing = true }
function compositionEnd() { composing = false }
function collapseExplorer() {
  if (props.remote) remoteExpanded.value = false
  else preference.value = false
  explorerButton.value?.focus({ preventScroll: true })
}
function toggleExplorer() {
  if (props.remote) remoteExpanded.value = !expanded.value
  else preference.value = !expanded.value
}
watch(() => props.contextKey, (key, previous) => {
  remoteExpanded.value = false
  if (previous !== undefined) cachedTabs.set(previous, tabs.value)
  tabs.value = cachedTabs.get(key) ?? { files: [], selected: '' }
})
watch(() => tabs.value.selected === '', value => emit('conversation-visible', value), { immediate: true, flush: 'sync' })
onMounted(() => {
  // Check overlays before a target's Tab handler can dismiss them.
  document.addEventListener('keydown', documentKey, true)
  document.addEventListener('compositionstart', compositionStart, true)
  document.addEventListener('compositionend', compositionEnd, true)
  window.addEventListener('blur', compositionEnd)
  window.addEventListener('shadow:cycle-document-tab', nativeDocumentKey)
  observer = new ResizeObserver(() => {
    if (root.value?.getClientRects().length) width.value = root.value.getBoundingClientRect().width
  })
  if (root.value) observer.observe(root.value)
})
onUnmounted(() => {
  observer?.disconnect()
  document.removeEventListener('keydown', documentKey, true)
  document.removeEventListener('compositionstart', compositionStart, true)
  document.removeEventListener('compositionend', compositionEnd, true)
  window.removeEventListener('blur', compositionEnd)
  window.removeEventListener('shadow:cycle-document-tab', nativeDocumentKey)
})
</script>

<style scoped>
.file-workbench { display: flex; position: relative; flex: 1; min-width: 0; min-height: 0; overflow: hidden; height: 100%; }
.workbench-explorer { position: relative; display: flex; flex: 0 0 var(--explorer-width, 220px); min-width: 0; min-height: 0; box-sizing: border-box; border-right: 1px solid var(--c-border); background: var(--c-bg-card); }
.workbench-editor { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.workbench-content { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-content.draft-document { justify-content: safe center; overflow-y: auto; padding: 40px 0 80px; box-sizing: border-box; }
.draft-document > .conversation-document { flex: 0 0 auto; overflow: visible; }
.document-toolbar { display: flex; align-items: stretch; flex: 0 0 40px; min-width: 0; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); }
.document-tablist { display: flex; flex: 1; min-width: 0; }
.document-tabs { display: flex; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: thin; }
.conversation-tab { flex: 0 0 auto; }
.document-tab { display: flex; flex-shrink: 0; min-width: 0; max-width: 240px; border-right: 1px solid var(--c-border); color: var(--c-text-secondary); }
.document-tab.selected { background: var(--c-bg); color: var(--c-text); box-shadow: inset 0 2px var(--c-blue); }
.document-tab [role="tab"] { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 0 12px; border: 0; background: transparent; color: inherit; font: inherit; font-size: 13px; cursor: pointer; }
.document-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.document-icon { flex: 0 0 16px; width: 16px; height: 16px; }
.workbench-button, .document-close { display: grid; place-items: center; flex-shrink: 0; width: 28px; height: 32px; align-self: center; padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.explorer-toggle { width: 36px; height: 36px; margin: 2px; }
.workbench-button > span, .document-close > span { display: block; width: 16px; height: 16px; }
.document-close { margin-right: 4px; }
button:hover { background: var(--c-bg-muted); color: var(--c-text); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.conversation-document, .file-document { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; }
.workbench-explorer.drawer { position: absolute; inset: calc(41px + var(--workbench-top-offset, 0px)) auto 0 0; width: min(260px, calc(100% - 32px)); z-index: 9; box-shadow: 8px 0 24px var(--c-shadow-soft); }
.explorer-backdrop { position: absolute; inset: calc(41px + var(--workbench-top-offset, 0px)) 0 0; border: 0; padding: 0; z-index: 8; background: rgb(0 0 0 / 20%); }
@media (max-width: 700px) {
  .workbench-content.draft-document { padding: 58px 0 28px; }
}
</style>
