<template>
  <section class="outline" :class="{ 'explorer-outline': explorer, 'explorer-expanded': explorer && expanded }" :aria-label="t('Outline')">
    <button v-if="explorer" type="button" class="outline-toggle" :aria-expanded="expanded" :aria-controls="treeId" @click="expanded = !expanded">
      <span :class="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" />
      <span class="i-lucide-list-tree" aria-hidden="true" />{{ t('Outline') }}
    </button>
    <h3 v-else>{{ t('Outline') }}</h3>
    <div v-show="!explorer || expanded" :id="treeId" ref="viewport" class="viewport">
      <ul>
        <li v-for="node in rows" :key="node.id" :data-selected="node.id === selectedId"
          :style="{ '--indent': Math.min(node.depth, 6) }">
          <HoverInfo v-if="index.parents.has(node.id)" :text="disclosureLabel(node)">
            <template #default="{ triggerProps, close }">
              <button type="button" class="square" v-bind="triggerProps" :aria-expanded="!collapsed.has(node.id)"
                :aria-label="disclosureLabel(node)" @click="toggle(node.id); close()">
                <span :class="collapsed.has(node.id) ? 'i-lucide-chevron-right' : 'i-lucide-chevron-down'" aria-hidden="true" />
              </button>
            </template>
          </HoverInfo>
          <span v-else class="spacer" aria-hidden="true" />
          <button type="button" class="row" :aria-current="node.id === selectedId ? 'true' : undefined" @click="emit('select', node.id)">
            <span class="schema-icon" :class="icons[node.kind] ?? 'i-lucide-box'" aria-hidden="true" />
            <span class="name">{{ label(node) }}<small v-if="index.ordinal.has(node.id)"> #{{ index.ordinal.get(node.id) }}</small></span>
            <span v-if="node.name" class="kind">{{ kindLabel(node) }}</span>
          </button>
        </li>
      </ul>
    </div>
    <footer v-if="(!explorer || expanded) && visible.length > pageSize">
      <HoverInfo :text="t('Previous page')" :disabled="page === 0">
        <template #default="{ triggerProps, close }">
          <button type="button" class="square" v-bind="triggerProps" :aria-label="t('Previous page')" :disabled="page === 0" @click="changePage(page - 1); close()"><span class="i-lucide-chevron-left" aria-hidden="true" /></button>
        </template>
      </HoverInfo>
      <span aria-live="polite">{{ t('{first}–{last} of {total}', { first: page * pageSize + 1, last: page * pageSize + rows.length, total: visible.length }) }}</span>
      <HoverInfo :text="t('Next page')" :disabled="page >= lastPage">
        <template #default="{ triggerProps, close }">
          <button type="button" class="square" v-bind="triggerProps" :aria-label="t('Next page')" :disabled="page >= lastPage" @click="changePage(page + 1); close()"><span class="i-lucide-chevron-right" aria-hidden="true" /></button>
        </template>
      </HoverInfo>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, useId, watch } from 'vue'
import { t, type MessageKey } from '../../i18n.ts'
import type { OtioModel, OtioNode } from '../../otio-model.ts'
import { visibleOtioNodes } from '../../otio-navigation.ts'
import HoverInfo from '../HoverInfo.vue'

const props = defineProps<{ model: OtioModel; selectedId: string; explorer?: boolean }>()
const expanded = ref(true)
const treeId = `otio-outline-${useId()}`
const emit = defineEmits<{ select: [id: string] }>()
const icons: Record<string, string> = {
  Timeline: 'i-lucide-timer', Stack: 'i-lucide-layers', Track: 'i-lucide-align-start-horizontal',
  Clip: 'i-lucide-film', Gap: 'i-lucide-square-dashed', Transition: 'i-lucide-blend',
}
const kinds = { Timeline: 'Timeline', Stack: 'Stack', Track: 'Track', Clip: 'Clip', Gap: 'Gap', Transition: 'Transition' } as const
const viewport = ref<HTMLElement>()
const collapsed = ref(new Set<string>())
const pageSize = 100
const page = ref(0)
const index = computed(() => {
  const nodes = new Map<string, OtioNode>()
  const parents = new Set<string>()
  const duplicates = new Map<string, string[]>()
  for (const node of props.model.nodes) {
    nodes.set(node.id, node)
    if (node.parentId !== null) parents.add(node.parentId)
    const key = JSON.stringify([node.parentId, node.name, node.kind])
    const group = duplicates.get(key) ?? []
    group.push(node.id)
    duplicates.set(key, group)
  }
  const ordinal = new Map<string, number>()
  for (const group of duplicates.values()) {
    if (group.length > 1) group.forEach((id, i) => ordinal.set(id, i + 1))
  }
  return { nodes, parents, ordinal }
})
const visible = computed(() => visibleOtioNodes(props.model.nodes, collapsed.value))
const lastPage = computed(() => Math.max(0, Math.ceil(visible.value.length / pageSize) - 1))
const rows = computed(() => visible.value.slice(page.value * pageSize, (page.value + 1) * pageSize))

function kindLabel(node: OtioNode) {
  const key = Object.hasOwn(kinds, node.kind) ? kinds[node.kind as keyof typeof kinds] : undefined
  return key ? t(key as MessageKey) : node.kind
}
function label(node: OtioNode) { return node.name || kindLabel(node) }
function disclosureLabel(node: OtioNode) {
  const name = label(node)
  return collapsed.value.has(node.id) ? t('Expand {name}', { name }) : t('Collapse {name}', { name })
}
function changePage(next: number) {
  page.value = next
  if (viewport.value) viewport.value.scrollTop = 0
}
function toggle(id: string) {
  if (!collapsed.value.delete(id)) collapsed.value.add(id)
  // Keep the toggled row rendered even if expanding an earlier page shifts the list.
  const position = visible.value.findIndex(node => node.id === id)
  if (position >= 0) page.value = Math.floor(position / pageSize)
}
watch(() => props.model, () => { collapsed.value.clear(); changePage(0) })
watch([() => props.model, () => props.selectedId], async () => {
  let node = index.value.nodes.get(props.selectedId)
  if (!node) return
  while (node?.parentId != null) {
    collapsed.value.delete(node.parentId)
    node = index.value.nodes.get(node.parentId)
  }
  const position = visible.value.findIndex(row => row.id === props.selectedId)
  if (position < 0) return
  page.value = Math.floor(position / pageSize)
  await nextTick()
  const view = viewport.value
  const selected = view?.querySelector('[data-selected="true"]')
  if (!view || !selected) return
  const row = selected.getBoundingClientRect()
  const box = view.getBoundingClientRect()
  if (row.top < box.top) view.scrollTop += row.top - box.top
  else if (row.bottom > box.bottom) view.scrollTop += row.bottom - box.bottom
}, { immediate: true })
</script>

<style scoped>
.outline { display: flex; flex-direction: column; min-width: 0; min-height: 0; max-height: 100%; container-type: inline-size; color: var(--c-text); background: var(--c-bg-card); }
.explorer-outline { flex: 0 0 auto; border-block-start: 1px solid var(--c-border); background: transparent; }
.explorer-expanded { flex: 1 1 0; }
.outline-toggle { flex-shrink: 0; display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; padding: 6px 8px; text-align: start; font-size: 12px; }
.outline-toggle > span { flex: 0 0 14px; height: 14px; }
.outline-toggle > span:nth-child(2) { color: var(--c-text-muted); }
.outline-toggle:hover { background: var(--c-bg-muted); }
.explorer-outline li { border-block-end: 0; padding-inline-start: calc(var(--indent) * 10px); }
.explorer-outline .square, .explorer-outline .spacer { flex-basis: var(--sidebar-disclosure, 20px); width: var(--sidebar-disclosure, 20px); }
.explorer-outline .row { min-height: var(--sidebar-row-height, 32px); }
.explorer-outline .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.explorer-outline .kind { flex-shrink: 0; }
h3 { margin: 0; padding: 8px 10px; font-size: 12px; font-weight: 650; background: var(--c-bg-soft); border-block-end: 1px solid var(--c-border); }
.viewport { overflow: auto; min-height: 0; }
ul { list-style: none; padding: 0; margin: 0; }
li { display: flex; align-items: stretch; padding-inline-start: calc(var(--indent) * clamp(6px, 2vw, 11px)); min-width: 0; border-block-end: 1px solid var(--c-border-soft); }
li[data-selected="true"] { background: var(--c-selection-bg); color: var(--c-primary); }
li:not([data-selected="true"]):hover { background: var(--c-bg-soft); }
button { color: inherit; border: 0; border-radius: 0; background: transparent; cursor: pointer; font: inherit; }
button:focus-visible { outline: 2px solid var(--c-primary); outline-offset: -2px; }
.square, .spacer { flex: 0 0 28px; min-height: 28px; }
.square { display: grid; place-items: center; padding: 0; width: 28px; }
.square:hover:not(:disabled) { background: var(--c-bg-muted); }
.square:disabled { opacity: .48; cursor: default; }
.row { display: flex; flex: 1; align-items: center; gap: 6px; min-width: 0; min-height: 30px; text-align: start; padding: 4px 8px 4px 0; font-size: 12px; line-height: 1.3; }
.schema-icon { flex: 0 0 14px; width: 14px; height: 14px; }
.name { overflow-wrap: anywhere; min-width: 0; }
.kind { color: var(--c-text-secondary); font-size: 10px; margin-inline-start: auto; overflow-wrap: anywhere; }
small { color: var(--c-text-secondary); font-size: 10px; font-variant-numeric: tabular-nums; white-space: nowrap; }
footer { display: flex; align-items: center; justify-content: space-between; gap: 4px; padding-inline: 4px; border-block-start: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 11px; font-variant-numeric: tabular-nums; }
@container (max-width: 260px) {
  .square, .spacer { flex-basis: 44px; min-height: 44px; }
  .square { width: 44px; }
  .row { min-height: 44px; }
}
@media (pointer: coarse) {
  .square, .spacer { flex-basis: 44px; min-height: 44px; }
  .square { width: 44px; }
  .row { min-height: 44px; }
}
</style>
