<template>
  <div ref="workspace" class="editor-workspace">
    <MobileEditorChrome :project-id="projectId" :active="!!active" :has-explorer="!!apiBase" :other-project-tabs="otherProjectTabs"
      @activate-project-tab="emit('activateProjectTab', $event)" />
    <header v-if="!mobile?.enabled.value" class="editor-workspace-header">
      <HoverInfo v-if="apiBase" :text="knowledgeContext ? t('Toggle Knowledge navigation (Ctrl+Shift+E)') : t('Toggle files (Ctrl+Shift+E)')" v-slot="{ triggerProps }"><button v-bind="triggerProps" ref="explorerToggle" class="project-explorer-toggle" :aria-label="knowledgeContext ? t('Toggle Knowledge navigation') : t('Toggle files')" aria-keyshortcuts="Control+Shift+E Meta+Shift+E" :aria-controls="`${hostId}-${knowledgeContext ? 'explorer' : 'files'}`" :aria-expanded="explorerOpen" @click="groups.toggleExplorer(projectId)"><span class="i-lucide-panel-left" aria-hidden="true" /></button></HoverInfo>
      <div class="editor-header-groups">
        <span v-if="showProjectMarker" class="editor-project-marker" :id="`${hostId}-project`">{{ projectName }}</span>
        <div v-for="side in sides" :key="side" :data-editor-header-group="side" class="editor-header-group" :class="{ 'active-group': state.active === side, 'empty-group': !state[side].length, 'drag-target': dragging, 'drag-over': dragOver === side }" :style="side === 'right' && state.left.length ? { flexBasis: `${rightWidth}px`, flexGrow: 0 } : undefined">
          <div class="editor-tabs" @pointerdown.capture="($event.button !== 1) && groups.focus(projectId, side)" @focusin="groups.focus(projectId, side)" @wheel="scrollEditorTabs($event, $event.currentTarget as HTMLElement)" @dragenter="drag.enter($event, side)" @dragover="drag.enter($event, side)" @dragleave="leaveDrop($event, side)" @drop="dropTab($event, side)" role="tablist" :aria-describedby="showProjectMarker ? `${hostId}-project` : undefined" :aria-label="t(side === 'left' ? 'Left editor group' : 'Right editor group')">
            <div v-for="editor in entries(side)" :key="editor.id" class="editor-tab" :class="{ selected: state.selected[side] === editor.id }" @mousedown="preventMiddleScroll" @auxclick="middleClickTab($event, editor.id)" @contextmenu.prevent="openMenu($event, editor.id)">
              <HoverInfo :text="editor.label" v-slot="{ triggerProps }"><button v-bind="triggerProps" draggable="true" @dragstart="drag.start($event, editor.id)" @dragend="drag.clear" :id="`${hostId}-tab-${encodeURIComponent(editor.id)}`" role="tab" :aria-controls="`${hostId}-${side}`" :aria-selected="state.selected[side] === editor.id" :tabindex="state.selected[side] === editor.id ? 0 : -1" @click="groups.activate(editor.id)" @keydown="tabKey($event, side, editor.id)"><SessionActivity v-if="editor.activity" v-bind="editor.activity" compact icon-only status-icons /><span v-else :class="editor.icon" aria-hidden="true" /><span class="editor-tab-label">{{ editor.label }}</span></button></HoverInfo>
              <HoverInfo v-if="editor.closable" :text="t('Close')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Close {value1}', { value1: editor.label })" @click="groups.close(editor.id)"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo>
            </div>
            <span v-if="dragging && !state[side].length" class="editor-drop-label">{{ t(side === 'left' ? 'Move to main area' : 'Move to right') }}</span>
          </div>
          <ProjectEditorTabs v-if="active && side === (state.right.length ? 'right' : 'left') && otherProjectTabs?.length" class="other-project-tabs" :groups="otherProjectTabs" :has-adjacent-project="hasLocalTabs" @activate="emit('activateProjectTab', $event)" @close="emit('closeProjectTab', $event)" />
        </div>
      </div>
    </header>
    <div class="editor-workspace-body">
      <MobileSheet v-if="apiBase && mobile?.enabled.value" :open="!!active && explorerOpen" :label="knowledgeContext ? t('Knowledge explorer') : t('File explorer')" side @update:open="!$event && closeExplorer()"><div ref="mobileExplorerTarget" class="mobile-explorer-target" /></MobileSheet>
      <Teleport :to="mobileExplorerTarget || 'body'" :disabled="!mobile?.enabled.value || !mobileExplorerTarget">
      <KnowledgeExplorer v-if="apiBase && knowledgeContext && explorerOpen" :key="projectId" :api-base="apiBase" :project-id="projectId" :active="!!active" :explorer-id="`${hostId}-explorer`" :selected-id="knowledgeContext.entryId" @select="selectKnowledge" @close="closeExplorer" />
      <!-- The file owner stays mounted: its EditorViewHosts own open file lifetimes. -->
      <ProjectFileExplorer v-if="apiBase" :api-base="apiBase" :project-id="projectId" :active="!!active" :open="explorerOpen && !knowledgeContext" :explorer-id="`${hostId}-files`" :folder-revision="folderRevision" :can-quote="!!groups.referenceTarget(projectId)" @quote="emit('quote', $event)" @close="closeExplorer" />
      </Teleport>
  <div ref="root" class="editor-groups">
    <nav v-if="state.left.length && state.right.length" class="mobile-group-switch" :aria-label="t('Open documents')"><button v-for="side in sides" :key="side" :aria-pressed="state.active === side" @click="groups.focus(projectId, side)">{{ t(side === 'left' ? 'Left editor group' : 'Right editor group') }}</button></nav>
    <section v-for="side in sides" :key="side" v-show="state[side].length" class="editor-group" :class="{ 'active-group': state.active === side }" :style="side === 'right' && state.left.length ? { flexBasis: `${rightWidth}px`, flexGrow: 0 } : undefined" :data-editor-group="side" @pointerdown.capture="groups.focus(projectId, side)" @focusin="groups.focus(projectId, side)">
      <SidebarResizer v-if="side === 'right' && state.left.length" edge="left" :model-value="rightWidth" :bounds="bounds" :label="t('Resize editor group')" :controls="`${hostId}-${side}`" @update:model-value="preferredWidth = $event" />
      <div :id="`${hostId}-${side}`" :ref="element => target(side, element)" class="editor-group-content" />
    </section>
    <Teleport to="body"><div v-if="menu" class="editor-menu-backdrop" @pointerdown.self="menu = undefined" @contextmenu.prevent.self="menu = undefined" @keydown="menuKey">
      <div class="editor-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
        <button role="menuitem" @click="moveMenu">{{ t(groups.side(menu.id) === 'right' ? 'Move to main area' : 'Move to right') }}</button>
        <button role="menuitem" :disabled="!groups.descriptors.get(menu.id)?.closable" @click="groups.close(menu.id); menu = undefined">{{ t('Close') }}</button>
      </div>
    </div></Teleport>
  </div>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, useId, watch, type ComponentPublicInstance } from 'vue'
import { EditorGroupsKey, type EditorSide } from '../editor-groups.ts'
import { documentTabDirection, isCloseDocumentKey, isCloseAllDocumentsKey, isToggleExplorerKey } from '../file-workbench.ts'
import { scrollEditorTabs, revealEditorTab } from '../editor-tab-scroll.ts'
import { createEditorTabDrag } from '../editor-tab-drag.ts'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import MobileSheet from './MobileSheet.vue'
import MobileEditorChrome from './MobileEditorChrome.vue'
import type { ProjectTopTabGroup } from '../project-top-tabs.ts'
import ProjectEditorTabs from './ProjectEditorTabs.vue'
import SessionActivity from './SessionActivity.vue'
import ProjectFileExplorer from './files/ProjectFileExplorer.vue'
import KnowledgeExplorer from './KnowledgeExplorer.vue'
import { t } from '../i18n.ts'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
const props = defineProps<{ projectId: string; projectName?: string; otherProjectTabs?: ProjectTopTabGroup[]; active?: boolean; apiBase?: string; folderRevision?: number }>()
const emit = defineEmits<{ quote: [text: string]; activateProjectTab: [id: string]; closeProjectTab: [id: string] }>()
const groups = inject(EditorGroupsKey)!
const mobile = useMobileChrome()
const mobileExplorerTarget = ref<HTMLElement>()
const sides: EditorSide[] = ['left', 'right']
const state = computed(() => groups.state(props.projectId))
const hasLocalTabs = computed(() => Boolean(state.value.left.length || state.value.right.length))
const showProjectMarker = computed(() => Boolean(props.projectName && hasLocalTabs.value && props.active && props.otherProjectTabs?.length))
const knowledgeContext = computed(() => groups.active(props.projectId)?.explorer)
const explorerOpen = computed(() => groups.explorerOpen(props.projectId))
// Open Knowledge navigation without changing the file explorer preference.
function selectKnowledge(id: string) {
  knowledgeContext.value?.select(id)
  if (mobile?.enabled.value) closeExplorer()
}
const drag = createEditorTabDrag(groups, () => props.projectId)
const dragging = computed(() => !!drag.active.value)
const dragOver = drag.over
watch(() => [props.projectId, props.active], () => drag.clear())
function leaveDrop(event: DragEvent, side: EditorSide) {
  if (!(event.relatedTarget instanceof Node) || !(event.currentTarget as HTMLElement).contains(event.relatedTarget)) { if (drag.over.value === side) drag.over.value = undefined }
}
function dropTab(event: DragEvent, side: EditorSide) {
  const id = drag.active.value?.id
  if (drag.drop(event, side) && id) focusTab(id)
}
// Native OS drag sessions may blur the window without leaving the renderer.
// dragend/drop own termination; hiding the document also invalidates the lease.
function hiddenDrag() { if (document.hidden) drag.clear() }
function cancelDrag(event: KeyboardEvent) { if (event.key === 'Escape') drag.clear() }
const hostId = `groups-${useId()}`
const root = ref<HTMLElement>()
const workspace = ref<HTMLElement>()
function acceptsShortcut() {
  return props.active && !!workspace.value?.getClientRects().length && !menu.value
    && ![...document.querySelectorAll<HTMLElement>('[role="dialog"], [role="menu"], dialog[open], [popover]:popover-open, .composer-popover-backdrop')].some(element => element.getClientRects().length > 0 && (!element.classList.contains('hover-info-popup') || element.contains(document.activeElement)))
}
const explorerToggle = ref<HTMLButtonElement>()
function preventMiddleScroll(event: MouseEvent) {
  if (event.button === 1) event.preventDefault()
}
function middleClickTab(event: MouseEvent, id: string) {
  if (event.button !== 1) return
  event.preventDefault()
  groups.close(id)
}
function closeExplorer() { groups.setExplorerOpen(props.projectId, false); explorerToggle.value?.focus() }
const width = ref(1000), preferredWidth = ref(480)
const bounds = computed(() => ({ min: 240, max: Math.max(240, width.value - 280) }))
const rightWidth = computed(() => Math.min(bounds.value.max, Math.max(bounds.value.min, preferredWidth.value)))
let observer: ResizeObserver | undefined
onMounted(() => { document.addEventListener('keydown', shortcut, true); window.addEventListener('dragend', drag.clear); window.addEventListener('drop', drag.clear); window.addEventListener('visibilitychange', hiddenDrag); window.addEventListener('keydown', cancelDrag, true); window.addEventListener('shadow:cycle-document-tab', nativeDocument); observer = new ResizeObserver(entries => { width.value = entries[0]?.contentRect.width ?? 1000 }); if (root.value) observer.observe(root.value) })
onUnmounted(() => { document.removeEventListener('keydown', shortcut, true); drag.clear(); window.removeEventListener('dragend', drag.clear); window.removeEventListener('drop', drag.clear); window.removeEventListener('visibilitychange', hiddenDrag); window.removeEventListener('keydown', cancelDrag, true); observer?.disconnect(); window.removeEventListener('shadow:cycle-document-tab', nativeDocument); for (const side of sides) groups.targets.delete(`${props.projectId}:${side}`) })
function entries(side: EditorSide) { return state.value[side].flatMap(id => { const editor = groups.descriptors.get(id); return editor ? [editor] : [] }) }
function target(side: EditorSide, element: Element | ComponentPublicInstance | null) { if (element instanceof HTMLElement) groups.targets.set(`${props.projectId}:${side}`, element) }
const menu = ref<{ id: string; x: number; y: number }>()
function openMenu(event: MouseEvent, id: string) { menu.value = { id, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 100) }; void nextTick(() => document.querySelector<HTMLButtonElement>('.editor-menu button')?.focus()) }
function moveMenu() { if (!menu.value) return; const id = menu.value.id; groups.move(id, groups.side(id) === 'left' ? 'right' : 'left'); menu.value = undefined; focusTab(id) }
function focusTab(id: string) { void nextTick(() => { const tab = document.getElementById(`${hostId}-tab-${encodeURIComponent(id)}`); if (tab) { tab.focus({ preventScroll: true }); revealEditorTab(tab) } }) }
function menuKey(event: KeyboardEvent) {
  if (!menu.value) return
  if (event.key === 'Escape' || event.key === 'Tab') { const id = menu.value.id; menu.value = undefined; if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); focusTab(id) }; return }
  if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
    event.preventDefault()
    const buttons = [...document.querySelectorAll<HTMLButtonElement>('.editor-menu button:not(:disabled)')]
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }
}
function nativeDocument(event: Event) {
  if (!acceptsShortcut()) return
  const action = (event as CustomEvent).detail, side = state.value.active, list = [...state.value[side]], current = state.value.selected[side]
  if (action === 'toggle-explorer') { if (props.apiBase) groups.toggleExplorer(props.projectId); else groups.active(props.projectId)?.commands?.toggleExplorer?.() }
  else if (action === 'close') groups.close(current)
  else if (action === 'close-all') for (const id of list) groups.close(id)
  else if ((action === -1 || action === 1) && list.length) { const id = list[(list.indexOf(current) + action + list.length) % list.length]!; groups.activate(id); focusTab(id) }
}
function tabKey(event: KeyboardEvent, side: EditorSide, id: string) {
  if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') { event.preventDefault(); const rect = (event.currentTarget as HTMLElement).getBoundingClientRect(); openMenu({ clientX: rect.left, clientY: rect.bottom } as MouseEvent, id); return }

  const list = state.value[side], index = list.indexOf(id)
  const next = event.key === 'Home' ? list[0] : event.key === 'End' ? list.at(-1) : event.key === 'ArrowRight' ? list[(index + 1) % list.length] : event.key === 'ArrowLeft' ? list[(index + list.length - 1) % list.length] : undefined
  if (next) { event.preventDefault(); groups.activate(next); focusTab(next) }
  if (event.key === 'Delete') { event.preventDefault(); groups.close(id) }
}
function shortcut(event: KeyboardEvent) {
  if (!acceptsShortcut()) return
  const direction = documentTabDirection(event)
  const action = isCloseAllDocumentsKey(event) ? 'close-all' : isCloseDocumentKey(event) ? 'close' : isToggleExplorerKey(event) ? 'toggle-explorer' : direction
  if (action === undefined) return
  event.preventDefault()
  event.stopPropagation()
  nativeDocument(new CustomEvent('shadow:cycle-document-tab', { detail: action }))
  focusTab(state.value.selected[state.value.active])
}
</script>
<style scoped>
.editor-workspace { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.editor-workspace-body { display: flex; flex: 1; min-height: 0; min-width: 0; }
.other-project-tabs { flex: 0 1 auto; border-inline-start: 1px solid var(--c-border); }
.editor-header-groups { display: flex; flex: 1; min-width: 0; }
.editor-header-group { display: flex; flex: 1; min-width: 0; }
.editor-header-group .editor-tabs { flex: 1; min-width: 0; border-bottom: 0; }
.editor-header-group:has(.other-project-tabs) .editor-tabs { flex: 0 1 auto; }
.editor-workspace-header { display: flex; height: 40px; min-height: 40px; box-sizing: border-box; flex-shrink: 0; background: var(--c-bg-soft); border-bottom: 1px solid var(--c-border); }
.project-explorer-toggle { display: grid; place-items: center; width: 36px; height: 36px; flex-shrink: 0; border: 0; background: transparent; color: var(--c-text-secondary); }
.project-explorer-toggle > span { width: 18px; height: 18px; }
.project-explorer-toggle:hover { background: var(--c-bg-muted); }
.project-explorer-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }

.editor-groups { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.editor-group { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.editor-group + .editor-group { border-left: 1px solid var(--c-border); }
/* A reserved 3px rail keeps native classic and overlay scrollbars inside the same header. */
.editor-tabs { display: flex; flex-wrap: nowrap; align-items: flex-start; height: 39px; min-height: 39px; box-sizing: border-box; overflow-x: scroll; overflow-y: hidden; flex-shrink: 0; background: var(--c-bg-soft); scrollbar-width: auto; }
.editor-tabs::-webkit-scrollbar { height: 3px; }
.editor-tabs::-webkit-scrollbar-thumb { background: var(--c-scrollbar-thumb); border-radius: 0; }
.editor-tabs::-webkit-scrollbar-thumb:hover { background: var(--c-scrollbar-thumb-hover); }
.editor-header-group.empty-group { flex: 0 0 120px !important; }
.editor-drop-label { align-self: center; padding: 0 12px; color: var(--c-text-secondary); font-size: 12px; pointer-events: none; }
.drag-target .editor-tabs { outline: 1px dashed var(--c-border-hover); outline-offset: -2px; min-width: 90px; }
.drag-over .editor-tabs { background: var(--c-selection-bg); outline: 2px solid var(--c-primary); outline-offset: -2px; }
.editor-tab [draggable="true"] { cursor: grab; }
.editor-tab { height: 36px; box-sizing: border-box; display: flex; flex-shrink: 0; min-width: 0; max-width: 240px; border-right: 1px solid var(--c-border-soft); border-top: 2px solid transparent; }
.editor-tab.selected { background: var(--c-bg-card); }
.active-group .editor-tab.selected { border-top-color: var(--c-primary); }
.editor-tab button { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 6px 10px; color: var(--c-text-secondary); font: inherit; font-size: 12px; white-space: nowrap; }
.editor-tab [role="tab"] { min-width: 0; }
.editor-tab button > span:not(.editor-tab-label) { width: 14px; height: 14px; flex-shrink: 0; }
.editor-tab-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.editor-tab button:not([role="tab"]) { flex-shrink: 0; }
.editor-tab.selected button { color: var(--c-text); }
.editor-tab button:hover { background: var(--c-bg-muted); }
.editor-tab button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.editor-group-content { display: flex; flex: 1; min-height: 0; min-width: 0; }
.editor-menu-backdrop { position: fixed; inset: 0; z-index: 1000; }
.editor-menu { position: absolute; display: grid; min-width: 200px; padding: 4px; background: var(--c-bg-card); border: 1px solid var(--c-border); box-shadow: 0 4px 16px var(--c-shadow); }
.editor-menu button { text-align: left; padding: 8px; border: 0; background: transparent; color: var(--c-text); }
.editor-menu button:hover { background: var(--c-bg-muted); }
.editor-menu button:disabled { color: var(--c-text-muted); }
.mobile-explorer-target { display: flex; flex-direction: column; flex: 1; min-height: 0; }
.mobile-explorer-target :deep(.knowledge-explorer-pane), .mobile-explorer-target :deep(.project-file-explorer) { width: 100%; flex: 1; border: 0; }
.mobile-group-switch { display: none; }
@media (max-width: 700px) {
  .editor-header-group { flex: 1 !important; flex-basis: 0 !important; }
  .editor-groups { flex-direction: column; }
  .mobile-group-switch { display: flex; border-bottom: 1px solid var(--c-border); }
  .mobile-group-switch button { flex: 1; min-height: 36px; border: 0; background: var(--c-bg-soft); color: var(--c-text-secondary); }
  .mobile-group-switch button[aria-pressed="true"] { color: var(--c-primary); background: var(--c-bg-card); }
  .editor-group { flex: 1 !important; flex-basis: 0 !important; width: 100%; }
  .editor-group:not(.active-group) { display: none !important; }
  .editor-group :deep(.sidebar-resizer) { display: none; }
}
</style>
