<template>
  <div ref="root" class="editor-groups" @keydown="shortcut">
    <nav v-if="state.left.length && state.right.length" class="mobile-group-switch" :aria-label="t('Open documents')"><button v-for="side in sides" :key="side" :aria-pressed="state.active === side" @click="groups.focus(projectId, side)">{{ t(side === 'left' ? 'Left editor group' : 'Right editor group') }}</button></nav>
    <section v-for="side in sides" :key="side" v-show="state[side].length" class="editor-group" :class="{ 'active-group': state.active === side }" :style="side === 'right' && state.left.length ? { flexBasis: `${rightWidth}px`, flexGrow: 0 } : undefined" :data-editor-group="side" @pointerdown.capture="groups.focus(projectId, side)" @focusin="groups.focus(projectId, side)">
      <SidebarResizer v-if="side === 'right' && state.left.length" edge="left" :model-value="rightWidth" :bounds="bounds" :label="t('Resize editor group')" :controls="`${hostId}-${side}`" @update:model-value="preferredWidth = $event" />
      <div class="editor-tabs" role="tablist" :aria-label="t(side === 'left' ? 'Left editor group' : 'Right editor group')">
        <div v-for="editor in entries(side)" :key="editor.id" class="editor-tab" :class="{ selected: state.selected[side] === editor.id }" @contextmenu.prevent="openMenu($event, editor.id)">
          <button :id="`${hostId}-tab-${encodeURIComponent(editor.id)}`" role="tab" :aria-controls="`${hostId}-${side}`" :aria-selected="state.selected[side] === editor.id" :tabindex="state.selected[side] === editor.id ? 0 : -1" @click="groups.activate(editor.id)" @keydown="tabKey($event, side, editor.id)"><span :class="editor.icon" aria-hidden="true" />{{ editor.label }}</button>
          <HoverInfo v-if="editor.closable" :text="t('Close')" v-slot="{ triggerProps }"><button v-bind="triggerProps" :aria-label="t('Close {value1}', { value1: editor.label })" @click="groups.close(editor.id)"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo>
        </div>
      </div>
      <div :id="`${hostId}-${side}`" :ref="element => target(side, element)" class="editor-group-content" />
    </section>
    <Teleport to="body"><div v-if="menu" class="editor-menu-backdrop" @pointerdown.self="menu = undefined" @contextmenu.prevent.self="menu = undefined" @keydown="menuKey">
      <div class="editor-menu" role="menu" :style="{ left: `${menu.x}px`, top: `${menu.y}px` }">
        <button role="menuitem" @click="moveMenu">{{ t(groups.side(menu.id) === 'right' ? 'Move to main area' : 'Move to right') }}</button>
        <button role="menuitem" :disabled="!groups.descriptors.get(menu.id)?.closable" @click="groups.close(menu.id); menu = undefined">{{ t('Close') }}</button>
      </div>
    </div></Teleport>
  </div>
</template>
<script setup lang="ts">
import { computed, inject, nextTick, onMounted, onUnmounted, ref, useId, type ComponentPublicInstance } from 'vue'
import { EditorGroupsKey, type EditorSide } from '../editor-groups.ts'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import { t } from '../i18n.ts'
const props = defineProps<{ projectId: string; active?: boolean }>()
const groups = inject(EditorGroupsKey)!
const sides: EditorSide[] = ['left', 'right']
const state = computed(() => groups.state(props.projectId))
const hostId = `groups-${useId()}`
const root = ref<HTMLElement>()
const width = ref(1000), preferredWidth = ref(480)
const bounds = computed(() => ({ min: 240, max: Math.max(240, width.value - 280) }))
const rightWidth = computed(() => Math.min(bounds.value.max, Math.max(bounds.value.min, preferredWidth.value)))
let observer: ResizeObserver | undefined
onMounted(() => { window.addEventListener('shadow:cycle-document-tab', nativeDocument); observer = new ResizeObserver(entries => { width.value = entries[0]?.contentRect.width ?? 1000 }); if (root.value) observer.observe(root.value) })
onUnmounted(() => { observer?.disconnect(); window.removeEventListener('shadow:cycle-document-tab', nativeDocument); for (const side of sides) groups.targets.delete(`${props.projectId}:${side}`) })
function entries(side: EditorSide) { return state.value[side].flatMap(id => { const editor = groups.descriptors.get(id); return editor ? [editor] : [] }) }
function target(side: EditorSide, element: Element | ComponentPublicInstance | null) { if (element instanceof HTMLElement) groups.targets.set(`${props.projectId}:${side}`, element) }
const menu = ref<{ id: string; x: number; y: number }>()
function openMenu(event: MouseEvent, id: string) { menu.value = { id, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 100) }; void nextTick(() => document.querySelector<HTMLButtonElement>('.editor-menu button')?.focus()) }
function moveMenu() { if (!menu.value) return; const id = menu.value.id; groups.move(id, groups.side(id) === 'left' ? 'right' : 'left'); menu.value = undefined; focusTab(id) }
function focusTab(id: string) { void nextTick(() => document.getElementById(`${hostId}-tab-${encodeURIComponent(id)}`)?.focus()) }
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
  if (!props.active || menu.value || document.querySelector('[aria-modal="true"]')) return
  const action = (event as CustomEvent).detail, side = state.value.active, list = [...state.value[side]], current = state.value.selected[side]
  if (action === 'toggle-explorer') groups.active(props.projectId)?.commands?.toggleExplorer?.()
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
  if (event.defaultPrevented || event.isComposing || menu.value || !(event.ctrlKey || event.metaKey) || event.altKey) return
  const side = state.value.active, list = state.value[side], current = state.value.selected[side]
  if (event.key.toLowerCase() === 'e' && event.shiftKey) { const command = groups.active(props.projectId)?.commands?.toggleExplorer; if (command) { event.preventDefault(); event.stopPropagation(); command() }; return }
  if (event.key.toLowerCase() === 'w') { event.preventDefault(); event.stopPropagation(); if (event.shiftKey) { for (const id of [...list]) groups.close(id) } else groups.close(current); focusTab(state.value.selected[side]) }
  if (event.key === 'Tab' && list.length) { event.preventDefault(); event.stopPropagation(); const next = list[(list.indexOf(current) + (event.shiftKey ? list.length - 1 : 1)) % list.length]!; groups.activate(next); focusTab(next) }
}
</script>
<style scoped>
.editor-groups { display: flex; flex: 1; min-height: 0; min-width: 0; overflow: hidden; }
.editor-group { position: relative; display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.editor-group + .editor-group { border-left: 1px solid var(--c-border); }
.editor-tabs { display: flex; min-height: 36px; overflow-x: auto; flex-shrink: 0; background: var(--c-bg-soft); border-bottom: 1px solid var(--c-border); }
.editor-tab { display: flex; flex-shrink: 0; border-right: 1px solid var(--c-border-soft); border-top: 2px solid transparent; }
.editor-tab.selected { background: var(--c-bg-card); }
.active-group .editor-tab.selected { border-top-color: var(--c-primary); }
.editor-tab button { display: flex; align-items: center; gap: 6px; border: 0; background: transparent; padding: 6px 10px; color: var(--c-text-secondary); font: inherit; font-size: 12px; white-space: nowrap; }
.editor-tab button span { width: 14px; height: 14px; }
.editor-tab.selected button { color: var(--c-text); }
.editor-tab button:hover { background: var(--c-bg-muted); }
.editor-tab button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.editor-group-content { display: flex; flex: 1; min-height: 0; min-width: 0; }
.editor-menu-backdrop { position: fixed; inset: 0; z-index: 1000; }
.editor-menu { position: absolute; display: grid; min-width: 200px; padding: 4px; background: var(--c-bg-card); border: 1px solid var(--c-border); box-shadow: 0 4px 16px var(--c-shadow); }
.editor-menu button { text-align: left; padding: 8px; border: 0; background: transparent; color: var(--c-text); }
.editor-menu button:hover { background: var(--c-bg-muted); }
.editor-menu button:disabled { color: var(--c-text-muted); }
.mobile-group-switch { display: none; }
@media (max-width: 700px) {
  .editor-groups { flex-direction: column; }
  .mobile-group-switch { display: flex; border-bottom: 1px solid var(--c-border); }
  .mobile-group-switch button { flex: 1; min-height: 36px; border: 0; background: var(--c-bg-soft); color: var(--c-text-secondary); }
  .mobile-group-switch button[aria-pressed="true"] { color: var(--c-primary); background: var(--c-bg-card); }
  .editor-group { flex: 1 !important; flex-basis: 0 !important; width: 100%; }
  .editor-group:not(.active-group) { display: none !important; }
  .editor-group :deep(.sidebar-resizer) { display: none; }
}
</style>
