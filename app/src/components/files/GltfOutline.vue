<template>
  <section class="gltf-structure">
    <h3 :id="`${id}-heading`">{{ t('Outline') }}</h3>
    <div ref="viewport" class="viewport" role="tree" :tabindex="visible.length ? 0 : -1"
      :aria-labelledby="`${id}-heading`" aria-multiselectable="true"
      :aria-activedescendant="activeDescendant" @scroll.passive="measure" @focus="onFocus" @keydown="onKeydown">
      <div role="presentation" class="extent" :style="{ height: `${visible.length * rowHeight}px` }">
        <div v-for="(node, offset) in windowRows" :id="rowId(node)" :key="node.row.key" class="row"
          role="treeitem" :aria-label="node.row.label" :aria-level="node.depth" :aria-posinset="node.position"
          :aria-setsize="index.siblingCounts.get(node.row.parentKey)"
          :aria-expanded="node.branch ? !collapsed.has(node.row.key) : undefined"
          :aria-selected="node.row.objectId === undefined ? undefined : selection.has(node.row.objectId)"
          :data-active="activeNode === node" :style="{
            top: `${(start + offset) * rowHeight}px`, height: `${rowHeight}px`, '--indent': Math.min(node.depth - 1, 8),
          }" @click="onRowClick(node, $event)">
          <HoverInfo v-if="node.branch" :text="disclosureLabel(node)">
            <template #default="{ triggerProps, close }">
              <button type="button" class="disclosure" tabindex="-1" v-bind="triggerProps"
                :aria-label="disclosureLabel(node)" @mousedown.prevent @click.stop="onDisclosure(node); close()">
                <span :class="collapsed.has(node.row.key) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" aria-hidden="true" />
              </button>
            </template>
          </HoverInfo>
          <span v-else class="spacer" aria-hidden="true" />
          <span :class="node.row.objectId === undefined ? 'i-lucide-folder' : 'i-lucide-box'" class="icon" aria-hidden="true" />
          <span class="label">{{ node.row.label }}</span>
        </div>
      </div>
    </div>
    <p v-if="!rows.length" class="empty">{{ t('No scene nodes') }}</p>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { t } from '../../i18n.ts'
import HoverInfo from '../HoverInfo.vue'

type Row = { key: string; parentKey: string | null; label: string; objectId?: string }
type Node = { row: Row; depth: number; position: number; ordinal: number; branch: boolean }
const props = defineProps<{ rows: readonly Row[]; selected: readonly string[] }>()
const emit = defineEmits<{ select: [objectIds: string[]] }>()
const id = useId()
const viewport = ref<HTMLElement>()
const collapsed = ref(new Set<string>())
const activeKey = ref<string>()
let anchorKey: string | undefined
let localSelection: string[] | undefined
const selection = computed(() => new Set(props.selected))
const index = computed(() => {
  const byKey = new Map<string, Node>()
  const byObject = new Map<string, Node[]>()
  const siblingCounts = new Map<string | null, number>()
  const nodes = props.rows.map((row, ordinal) => {
    const parent = row.parentKey === null ? undefined : byKey.get(row.parentKey)
    if (parent) parent.branch = true
    const position = (siblingCounts.get(row.parentKey) ?? 0) + 1
    siblingCounts.set(row.parentKey, position)
    const node: Node = { row, depth: (parent?.depth ?? 0) + 1, position, ordinal, branch: false }
    byKey.set(row.key, node)
    if (row.objectId !== undefined) {
      const matches = byObject.get(row.objectId)
      if (matches) matches.push(node)
      else byObject.set(row.objectId, [node])
    }
    return node
  })
  return { nodes, byKey, byObject, siblingCounts }
})
const projection = computed(() => {
  const visible: Node[] = []
  const positions = new Map<string, number>()
  let hiddenBelow = Infinity
  for (const node of index.value.nodes) {
    if (node.depth > hiddenBelow) continue
    hiddenBelow = collapsed.value.has(node.row.key) ? node.depth : Infinity
    positions.set(node.row.key, visible.length)
    visible.push(node)
  }
  return { visible, positions }
})
const visible = computed(() => projection.value.visible)
const activeNode = computed(() => visible.value[position(activeKey.value)] ?? visible.value[0])
const scrollTop = ref(0)
const viewportHeight = ref(0)
const rowHeight = ref(32)
const overscan = 6
const start = computed(() => Math.max(0, Math.min(visible.value.length - 1, Math.floor(scrollTop.value / rowHeight.value) - overscan)))
const end = computed(() => Math.min(visible.value.length, Math.max(start.value + 1, Math.ceil((scrollTop.value + viewportHeight.value) / rowHeight.value) + overscan)))
const windowRows = computed(() => visible.value.slice(start.value, end.value))
const activeDescendant = computed(() => {
  const node = activeNode.value
  const i = position(node?.row.key)
  return node && i >= start.value && i < end.value ? rowId(node) : undefined
})

let resize: ResizeObserver | undefined
let coarse: MediaQueryList | undefined
function measure() {
  const view = viewport.value
  if (!view) return
  viewportHeight.value = view.clientHeight
  scrollTop.value = view.scrollTop
}
function updateDensity() {
  rowHeight.value = coarse?.matches ? 44 : 32
  void nextTick(() => { measure(); reveal(activeNode.value) })
}
onMounted(() => {
  coarse = window.matchMedia('(pointer: coarse), (max-width: 700px)')
  coarse.addEventListener('change', updateDensity)
  updateDensity()
  resize = new ResizeObserver(measure)
  if (viewport.value) resize.observe(viewport.value)
})
onBeforeUnmount(() => { resize?.disconnect(); coarse?.removeEventListener('change', updateDensity) })

function rowId(node: Node) { return `${id}-node-${node.ordinal}` }
function position(key: string | undefined) { return key === undefined ? -1 : projection.value.positions.get(key) ?? -1 }
function disclosureLabel(node: Node) {
  return collapsed.value.has(node.row.key) ? t('Expand {name}', { name: node.row.label }) : t('Collapse {name}', { name: node.row.label })
}
function reveal(node: Node | undefined) {
  const view = viewport.value
  const i = position(node?.row.key)
  if (!view?.clientHeight || i < 0) return
  const top = i * rowHeight.value
  const bottom = top + rowHeight.value
  if (top < view.scrollTop || rowHeight.value > view.clientHeight) view.scrollTop = top
  else if (bottom > view.scrollTop + view.clientHeight) view.scrollTop = bottom - view.clientHeight
  measure()
}
function activate(node: Node) { activeKey.value = node.row.key; reveal(node) }
function onFocus() { reveal(activeNode.value) }
function focusTree(node: Node) {
  activate(node)
  viewport.value?.focus({ preventScroll: true })
}
function toggle(node: Node) {
  if (!node.branch) return
  if (!collapsed.value.delete(node.row.key)) collapsed.value.add(node.row.key)
  void nextTick(measure)
}
function onDisclosure(node: Node) { focusTree(node); toggle(node) }
function onRowClick(node: Node, event: MouseEvent) {
  focusTree(node)
  if (node.row.objectId === undefined) toggle(node)
  else select(node, event.shiftKey, event.ctrlKey || event.metaKey)
}
function select(node: Node, range: boolean, additive: boolean) {
  const objectId = node.row.objectId
  if (objectId === undefined) return
  const anchor = position(anchorKey)
  let next: Set<string>
  if (range && anchor >= 0) {
    const target = position(node.row.key)
    next = additive ? new Set(selection.value) : new Set()
    for (let i = Math.min(anchor, target); i <= Math.max(anchor, target); i++) {
      const object = visible.value[i]?.row.objectId
      if (object !== undefined) next.add(object)
    }
  } else {
    anchorKey = node.row.key
    next = additive ? new Set(selection.value) : new Set()
    if (!additive || !next.delete(objectId)) next.add(objectId)
  }
  const emitted = [...next]
  localSelection = emitted
  emit('select', emitted)
  // Only a prop update in the same Vue flush is the local selection's echo.
  void nextTick(() => { if (localSelection === emitted) localSelection = undefined })
}
function onKeydown(event: KeyboardEvent) {
  if (event.target !== viewport.value || event.altKey || event.isComposing) return
  const current = activeNode.value
  if (!current) return
  const i = position(current.row.key)
  let next: Node | undefined
  switch (event.key) {
    case 'ArrowUp': next = visible.value[i - 1]; break
    case 'ArrowDown': next = visible.value[i + 1]; break
    case 'Home': next = visible.value[0]; break
    case 'End': next = visible.value.at(-1); break
    case 'ArrowRight':
      if (current.branch && collapsed.value.has(current.row.key)) toggle(current)
      else if (current.branch) next = visible.value[i + 1]
      break
    case 'ArrowLeft':
      if (current.branch && !collapsed.value.has(current.row.key)) toggle(current)
      else if (current.row.parentKey !== null) next = index.value.byKey.get(current.row.parentKey)
      break
    case 'Enter':
    case ' ':
      if (current.row.objectId === undefined) toggle(current)
      else select(current, event.shiftKey, event.ctrlKey || event.metaKey || (event.key === ' ' && !event.shiftKey))
      break
    default: return
  }
  event.preventDefault()
  if (!next) return
  if (event.shiftKey && position(anchorKey) < 0 && current.row.objectId !== undefined) anchorKey = current.row.key
  activate(next)
  if (event.shiftKey && next.row.objectId !== undefined && ['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
    select(next, true, event.ctrlKey || event.metaKey)
  }
}

watch([index, () => [...props.selected]], async ([model, selected], previous, onCleanup) => {
  const replaced = model !== previous?.[0]
  const prior = new Set(previous?.[1])
  const echo = !replaced && localSelection !== undefined && selected.length === localSelection.length && selected.every((value, i) => value === localSelection?.[i])
  localSelection = undefined
  if (replaced) {
    for (const key of collapsed.value) if (!model.byKey.get(key)?.branch) collapsed.value.delete(key)
    if (position(activeKey.value) < 0) activeKey.value = undefined
    if (!model.byKey.has(anchorKey ?? '')) anchorKey = undefined
  }
  if (echo) return
  let target: Node | undefined
  const visited = new Set<string>()
  for (const objectId of selected) {
    if (!replaced && prior.has(objectId)) continue
    const matches = model.byObject.get(objectId)
    if (!matches) continue
    target = matches[0]
    for (const match of matches) {
      let parentKey = match.row.parentKey
      while (parentKey !== null && !visited.has(parentKey)) {
        visited.add(parentKey)
        collapsed.value.delete(parentKey)
        parentKey = model.byKey.get(parentKey)?.row.parentKey ?? null
      }
    }
  }
  if (!target) { if (!replaced) anchorKey = undefined; return }
  activeKey.value = anchorKey = target.row.key
  let cancelled = false
  onCleanup(() => { cancelled = true })
  // Wait for the virtual extent to grow before changing its scroll offset.
  await nextTick()
  if (!cancelled) reveal(target)
}, { immediate: true })
</script>

<style scoped>
.gltf-structure { display: flex; flex-direction: column; min-width: 0; min-height: 0; max-height: 100%; color: var(--c-text); background: var(--c-bg-card); }
h3 { margin: 0; padding: 8px 10px; font-size: 12px; font-weight: 650; background: var(--c-bg-soft); border-block-end: 1px solid var(--c-border); }
.viewport { overflow: auto; min-height: 0; max-height: 24rem; overscroll-behavior: contain; overflow-anchor: none; }
.viewport:focus-visible { outline: 2px solid var(--c-primary); outline-offset: -2px; }
.extent { position: relative; }
.row { position: absolute; inset-inline: 0; display: flex; align-items: center; gap: 5px; box-sizing: border-box; padding-inline: calc(var(--indent) * clamp(6px, 1vw, 11px)) 8px; border-block-end: 1px solid var(--c-border-soft); font-size: 12px; cursor: pointer; user-select: none; }
.row:hover { background: var(--c-bg-soft); }
.row[aria-selected="true"] { background: var(--c-selection-bg); }
.viewport:focus-visible .row[data-active="true"] { outline: 2px solid var(--c-primary); outline-offset: -2px; }
.disclosure, .spacer { width: 32px; height: 100%; flex: 0 0 32px; }
.row :deep(.hover-info-anchor) { height: 100%; }
.disclosure { display: grid; place-items: center; border: 0; padding: 0; background: transparent; color: inherit; cursor: pointer; }
.disclosure:hover { background: var(--c-bg-muted); }
.disclosure:focus-visible { outline: 2px solid var(--c-primary); outline-offset: -2px; }
.disclosure span, .icon { width: 14px; height: 14px; flex: 0 0 14px; }
.icon { color: var(--c-text-secondary); }
.label { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.empty { margin: 0; padding: 8px 10px; color: var(--c-text-secondary); font-size: 12px; }
@media (pointer: coarse), (max-width: 700px) {
  .disclosure, .spacer { width: 44px; flex-basis: 44px; }
}
</style>
