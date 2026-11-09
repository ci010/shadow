<template>
  <div ref="viewport" class="work-lane" tabindex="0" role="list" :aria-label="label" @scroll="onScroll" @keydown="navigate" @focusout="releaseFocus">
    <div class="lane-space" :style="{ height: `${offsets.at(-1)}px` }">
      <div v-for="entry in visibleRows" :key="entry.row.key" :ref="el => measureElement(el, entry.row.key)"
        class="lane-row" :data-row-key="entry.row.key" role="listitem" :aria-setsize="rows.length" :aria-posinset="entry.index + 1"
        :aria-label="entry.row.groupTitle" :style="{ transform: `translateY(${entry.offset}px)` }" @focusin="focused = entry.row.key">
        <h4 v-if="entry.row.startsGroup">{{ entry.row.groupTitle }}</h4>
        <WorkItemCard :item="entry.row.item" :selected="selected === entry.row.key"
          :session-title="sessionTitle(entry.row.item.assignee)" :session-exists="sessionExists(entry.row.item.assignee)"
          @select="$emit('select', $event)" @session="$emit('session', $event)" />
      </div>
    </div>
    <p v-if="!rows.length" class="lane-empty">{{ t('No items') }}</p>
  </div>
</template>
<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import WorkItemCard from './WorkItemCard.vue'
import { measuredOffsets, measuredRange, type WorkBoardRow } from '../work-board.ts'
import { t } from '../i18n.ts'
const props = defineProps<{ rows: WorkBoardRow[]; label: string; selected: string; sessionTitle: (id: string | null) => string; sessionExists: (id: string | null) => boolean }>()
defineEmits<{ select: [key: string]; session: [id: string] }>()
const viewport = ref<HTMLElement>(), top = ref(0), height = ref(0), focused = ref('')
const sizes = shallowRef(new Map<string, number>())
const offsets = computed(() => measuredOffsets(props.rows.map(row => row.key), sizes.value))
const indexes = computed(() => {
  const { start, end } = measuredRange(offsets.value, top.value, height.value)
  const result = Array.from({ length: end - start }, (_, i) => start + i)
  const pin = props.rows.findIndex(row => row.key === focused.value)
  // Retain at most one focused row, never the entire span back to it.
  if (pin >= 0 && !result.includes(pin)) result.push(pin)
  return result.sort((a, b) => a - b)
})
const visibleRows = computed(() => indexes.value.map(index => ({ row: props.rows[index]!, index, offset: offsets.value[index]! })))
let observer: ResizeObserver | undefined, width = 0
const elements = new Map<string, HTMLElement>()
function measureElement(el: Element | ComponentPublicInstance | null, key: string) {
  const previous = elements.get(key)
  if (previous === el) return
  if (previous) observer?.unobserve(previous)
  if (el instanceof HTMLElement) { elements.set(key, el); observer?.observe(el) }
  else elements.delete(key)
}
function onScroll() { top.value = viewport.value?.scrollTop ?? 0 }
function releaseFocus() { void nextTick(() => { if (!viewport.value?.contains(document.activeElement)) focused.value = '' }) }
async function focusRow(index: number) {
  if (!viewport.value || !props.rows[index]) return
  focused.value = props.rows[index]!.key
  viewport.value.scrollTop = offsets.value[index]!
  onScroll()
  await nextTick()
  elements.get(focused.value)?.querySelector<HTMLButtonElement>('.work-title')?.focus({ preventScroll: true })
}
function navigate(event: KeyboardEvent) {
  if (event.altKey || event.ctrlKey || event.metaKey) return
  const index = props.rows.findIndex(row => row.key === focused.value)
  let target: number | undefined
  if (event.key === 'ArrowDown') target = Math.min(props.rows.length - 1, index + 1)
  if (event.key === 'ArrowUp') target = Math.max(0, index - 1)
  if (event.key === 'Home') target = 0
  if (event.key === 'End') target = props.rows.length - 1
  // Tab crosses virtual boundaries just as it crosses ordinary cards; links and
  // assignee controls within a card retain their native tab order.
  if (event.key === 'Tab' && index >= 0) {
    const controls = [...elements.get(focused.value)!.querySelectorAll<HTMLElement>('button, a[href]')]
    if (!event.shiftKey && document.activeElement === controls.at(-1) && index < props.rows.length - 1) target = index + 1
    if (event.shiftKey && document.activeElement === controls[0] && index > 0) {
      event.preventDefault()
      void focusRow(index - 1).then(() => elements.get(focused.value)?.querySelectorAll<HTMLElement>('button, a[href]').item((elements.get(focused.value)?.querySelectorAll('button, a[href]').length ?? 1) - 1)?.focus({ preventScroll: true }))
      return
    }
  }
  if (target !== undefined && target >= 0) { event.preventDefault(); void focusRow(target) }
}
watch(() => props.rows, () => {
  // Filter/reorder/status changes invalidate geometry and return to a real row.
  sizes.value = new Map(); focused.value = ''; top.value = 0
  if (viewport.value) viewport.value.scrollTop = 0
  void nextTick(() => { for (const el of elements.values()) { observer?.unobserve(el); observer?.observe(el) } })
})
onMounted(() => {
  observer = new ResizeObserver(entries => {
    const next = new Map(sizes.value)
    let changed = false
    for (const entry of entries) {
      if (entry.target === viewport.value) {
        height.value = viewport.value.clientHeight
        if (width !== viewport.value.clientWidth) {
          width = viewport.value.clientWidth; next.clear(); changed = true
          // A width change need not change every row's height. Seed all mounted
          // rows now; unchanged rows will not receive another resize delivery.
          for (const [key, el] of elements) {
            const size = el.getBoundingClientRect().height
            if (size > 0) next.set(key, size)
          }
        }
      } else {
        const el = entry.target as HTMLElement, key = el.dataset.rowKey!
        const size = el.getBoundingClientRect().height
        if (size > 0 && next.get(key) !== size) { next.set(key, size); changed = true }
      }
    }
    if (changed) sizes.value = next
  })
  if (viewport.value) observer.observe(viewport.value)
  for (const el of elements.values()) observer.observe(el)
})
onUnmounted(() => observer?.disconnect())
</script>
<style scoped>
.work-lane { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; overscroll-behavior-y: contain; scrollbar-gutter: stable; overflow-anchor: none; padding: 3px; }
.work-lane:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.lane-space { position: relative; }
.lane-row { position: absolute; top: 0; left: 0; right: 0; padding-bottom: 12px; }
h4 { font-size: 12px; font-weight: 500; color: var(--c-text-secondary); margin: 4px 0 8px; overflow-wrap: anywhere; }
.lane-empty { font-size: 12px; color: var(--c-text-secondary); }
</style>
