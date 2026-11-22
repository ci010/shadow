<template>
  <section class="storyboard" :aria-label="t('Storyboard')">
    <header class="board-toolbar">
      <div class="board-primary">
        <slot name="mode" />
        <div class="board-view">
          <span class="shot-count" role="status">{{ shotCount }}</span>
          <div v-if="rows.length" class="board-zoom" role="group" :aria-label="t('Storyboard zoom')">
            <HoverInfo v-for="control in zoomControls" :key="control.label" :text="t(control.label)" v-slot="{ triggerProps }">
              <button type="button" class="board-action icon-action" v-bind="triggerProps" :aria-label="t(control.label)"
                :disabled="control.step < 0 ? zoom <= MIN_ZOOM : zoom >= MAX_ZOOM" @click="changeZoom(control.step)">
                <span :class="control.icon" aria-hidden="true" />
              </button>
            </HoverInfo>
            <button class="board-action fit-width" type="button" @click="fitWidth">{{ t('Fit width') }}</button>
          </div>
        </div>
      </div>
      <div class="board-filters">
        <label class="select-filter">{{ t('Picture source') }}
          <span class="select-wrap">
            <select v-model="solo" :disabled="!track">
              <option :value="false">{{ t('Final timeline') }}</option>
              <option v-if="track" :value="true">{{ t('Solo: {name}', { name: track.name || t('Video track') }) }}</option>
            </select>
            <span class="i-lucide-chevron-down" aria-hidden="true" />
          </span>
        </label>
        <label class="select-filter">{{ t('Sampling') }}
          <span class="select-wrap">
            <select v-model="interval">
              <option :value="false">{{ t('Per visible shot') }}</option>
              <option :value="true">{{ t('Every 2 seconds') }}</option>
            </select>
            <span class="i-lucide-chevron-down" aria-hidden="true" />
          </span>
        </label>
        <div class="description-filter">
          <label><input v-model="missing" type="checkbox" :disabled="!available"> {{ t('Missing descriptions only') }}</label>
          <HoverInfo v-if="available" interactive :label="t('Description storage')"
            :text="t('Descriptions are saved in this browser profile for this timeline revision. The OTIO file is unchanged.')" v-slot="{ triggerProps }">
            <button type="button" class="board-action icon-action" v-bind="triggerProps" :aria-label="t('Description storage')" @keydown.esc="triggerProps['aria-expanded'] && $event.stopPropagation()">
              <span class="i-lucide-info" aria-hidden="true" />
            </button>
          </HoverInfo>
        </div>
      </div>
      <p v-if="!available" class="description-warning" role="status"><span class="i-lucide-triangle-alert" aria-hidden="true" />{{ t('Local descriptions are unavailable for this preview.') }}</p>
    </header>
    <form v-if="editing !== null && available" class="description-editor" @submit.prevent="save" @keydown.esc.stop="closeEditor">
      <label>{{ t('Shot description: {name}', { name: editingName }) }}
        <textarea ref="editor" v-model="text" class="input" :maxlength="DESCRIPTION_LIMIT" rows="2" />
      </label>
      <div><button class="btn btn-sm btn-primary" type="submit" :disabled="!active">{{ t('Save') }}</button>
        <button class="btn btn-sm" type="button" @click="closeEditor">{{ t('Cancel') }}</button></div>
      <p v-if="saveFailed" role="alert">{{ t('Description could not be saved to this browser.') }}</p>
    </form>
    <div ref="scroll" class="board-scroll" :tabindex="rows.length ? 0 : undefined" role="region" :aria-label="t('Storyboard pictures')">
      <p v-if="!rows.length" class="empty-board" role="status">{{ missing ? t('No shots with missing descriptions.') : t('No storyboard pictures at this sampling.') }}</p>
      <VueFlow v-else class="board-flow" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }"
        :nodes="layout.nodes" :nodes-draggable="false" :nodes-connectable="false" :nodes-focusable="false" :disable-keyboard-a11y="true"
        :elements-selectable="false" :delete-key-code="null" :selection-key-code="null" :connect-on-click="false"
        :pan-on-drag="false" :zoom-on-scroll="false" :zoom-on-pinch="false" :zoom-on-double-click="false"
        :pan-activation-key-code="null" :zoom-activation-key-code="null" :prevent-scrolling="false"
        :min-zoom="MIN_ZOOM" :max-zoom="MAX_ZOOM" :default-viewport="{ x: 0, y: 0, zoom }" @pane-ready="syncViewport">
        <template #node-shot="{ data: { row, number } }">
          <article class="card" :class="{ 'current-shot': isCurrent(row) }">
            <button type="button" class="sample" :aria-current="isCurrent(row) ? 'true' : undefined"
              @click="choose(row, false)" @keydown.enter.prevent="choose(row, true)" @dblclick="choose(row, true)">
              <OtioStoryboardPicture :medium="row.medium" :seconds="row.position" :gap="!row.node" :active="active" :unlinked="unlinked" />
              <span class="sample-meta"><span class="shot-index">{{ formatNumber(number, { minimumIntegerDigits: 2, useGrouping: false }) }}</span>
                <time>{{ t('{time} s', { time: formatNumber(row.seconds, { maximumFractionDigits: 3 }) }) }}</time></span>
              <span class="sample-name">{{ row.node ? row.node.name || t('Unnamed element') : t('No picture / gap') }}</span>
            </button>
            <template v-if="row.node && row.caption">
              <p v-if="descriptions.has(row.node.id)" class="caption selectable-text" tabindex="0">{{ descriptions.get(row.node.id) }}</p>
              <button v-if="available" class="btn btn-sm caption-action" type="button" :aria-label="t('Shot description: {name}', { name: row.node.name || t('Unnamed element') })" @click="edit(row.node, $event)">
                {{ descriptions.has(row.node.id) ? t('Edit description') : t('Add description') }}
              </button>
            </template>
          </article>
        </template>
      </VueFlow>
    </div>
    <footer v-if="order.count > STORYBOARD_PAGE" class="board-pagination">
      <button class="btn btn-sm" type="button" :disabled="!page" @click="page--">{{ t('Previous page') }}</button>
      <span>{{ t('Page {page} of {total}', { page: page + 1, total: maxPage + 1 }) }}</span>
      <button class="btn btn-sm" type="button" :disabled="page === maxPage" @click="page++">{{ t('Next page') }}</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { VueFlow, useVueFlow, type Node } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import { computed, nextTick, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { formatNumber, t } from '../../i18n.ts'
import type { OtioModel, OtioNode } from '../../otio-model.ts'
import { mediaPosition, type OtioDocument, type OtioMedium } from '../../otio-review.ts'
import { DESCRIPTION_LIMIT, STORYBOARD_PAGE, readStoryboardDescriptions, storyboardKey, storyboardOrder } from '../../otio-storyboard.ts'
import HoverInfo from '../HoverInfo.vue'
import OtioStoryboardPicture from './OtioStoryboardPicture.vue'

const props = defineProps<{ model: OtioModel; source: OtioDocument; apiBase: string; active: boolean; track?: OtioNode; hidden?: ReadonlySet<string>;
  mediaFor: (node: OtioNode) => (OtioMedium & { url: string }) | null; unlinked: string; current: number; selectedId: string }>()
const emit = defineEmits<{ position: [seconds: number, node: OtioNode | null, solo: boolean, monitor: boolean] }>()
const interval = ref(false), missing = ref(false), solo = ref(false), page = ref(0), scroll = ref<HTMLElement>()
const descriptions = shallowRef(new Map<string, string>()), available = ref(false), saveFailed = ref(false)
const zoomControls = [{ label: 'Zoom out', icon: 'i-lucide-minus', step: -1 }, { label: 'Zoom in', icon: 'i-lucide-plus', step: 1 }] as const
const MIN_ZOOM = .75, MAX_ZOOM = 1.5
const zoom = ref(1), screenWidth = ref(0)
const flow = useVueFlow()
const editor = ref<HTMLTextAreaElement>()
let returnFocus: HTMLElement | null = null
const editing = ref<string | null>(null), editingName = ref(''), text = ref('')
const key = computed(() => props.unlinked ? null : storyboardKey(props.apiBase, props.source))
function load() {
  const id = key.value
  try {
    descriptions.value = id ? readStoryboardDescriptions(localStorage, id) : new Map()
    available.value = !!id
  } catch { descriptions.value = new Map(); available.value = false }
  if (!available.value) { missing.value = false; editing.value = null }
}
watch(key, () => { editing.value = null; load() }, { immediate: true })
function storage(event: StorageEvent) { if (!event.key || event.key === key.value) load() }
let resize: ResizeObserver | undefined
let resizeFrame = 0
onMounted(() => {
  window.addEventListener('storage', storage)
  resize = new ResizeObserver(() => {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => {
      const width = scroll.value?.clientWidth ?? 0
      if (width > 0) screenWidth.value = width
    })
  })
  if (scroll.value) resize.observe(scroll.value)
})
onBeforeUnmount(() => {
  resize?.disconnect(); cancelAnimationFrame(resizeFrame); window.removeEventListener('storage', storage)
})
function edit(node: OtioNode, event: MouseEvent) {
  returnFocus = event.currentTarget instanceof HTMLElement ? event.currentTarget : null
  editing.value = node.id; editingName.value = node.name || t('Unnamed element'); text.value = descriptions.value.get(node.id) ?? ''; saveFailed.value = false
  void nextTick(() => editor.value?.focus())
}
function closeEditor() {
  editing.value = null
  void nextTick(() => (returnFocus?.isConnected ? returnFocus : scroll.value)?.focus({ preventScroll: true }))
}
function save() {
  const id = key.value, clip = editing.value
  if (!id || clip === null || !props.active || !available.value) return
  try {
    const next = readStoryboardDescriptions(localStorage, id), value = text.value.trim()
    if (value) next.set(clip, value.slice(0, DESCRIPTION_LIMIT)); else next.delete(clip)
    localStorage.setItem(id, JSON.stringify(Object.fromEntries(next)))
    descriptions.value = next; closeEditor()
  } catch { saveFailed.value = true }
}
const order = computed(() => storyboardOrder(props.model, solo.value ? props.track : undefined, interval.value,
  missing.value ? node => !descriptions.value.has(node.id) : undefined, props.hidden))
const maxPage = computed(() => Math.max(0, Math.ceil(order.value.count / STORYBOARD_PAGE) - 1))
const rows = computed(() => {
  const seen = new Set<string>()
  return order.value.page(page.value * STORYBOARD_PAGE).map(row => {
    const caption = !!row.node && !seen.has(row.node.id)
    if (row.node) seen.add(row.node.id)
    const medium = row.node?.sourceStart ? props.mediaFor(row.node) : null
    return { ...row, caption, medium: medium?.kind === 'audio' ? null : medium,
      position: row.node ? mediaPosition(row.node, row.seconds) : null }
  })
})
const shotCount = computed(() => order.value.count > STORYBOARD_PAGE && rows.value.length
  ? t('Shots {first}–{last} of {total}', { first: formatNumber(page.value * STORYBOARD_PAGE + 1), last: formatNumber(page.value * STORYBOARD_PAGE + rows.value.length), total: formatNumber(order.value.count) })
  : t('{count} shots', { count: formatNumber(order.value.count) }, order.value.count))
type Shot = (typeof rows.value)[number]
// A scaled Flow surface inside a native scrollport keeps wheel, touch and keyboard
// scrolling predictable. Only the board's controls can change the viewport scale.
const layout = computed(() => {
  const scale = zoom.value, inset = 16, gap = 16
  const availableWidth = Math.max(1, screenWidth.value / scale - 2 * inset)
  const columns = Math.min(4, Math.max(1, Math.floor((availableWidth + gap) / (190 + gap))))
  const width = Math.min(340, Math.max(160, (availableWidth - (columns - 1) * gap) / columns))
  const nodes: Node<{ row: Shot; number: number }>[] = []
  let y = inset
  for (let i = 0; i < rows.value.length; i += columns) {
    const line = rows.value.slice(i, i + columns)
    let extra = 0
    line.forEach((row, column) => {
      if (row.node && row.caption && available.value) extra = Math.max(extra, descriptions.value.has(row.node.id) ? 92 : 35)
      nodes.push({ id: String(row.seconds), type: 'shot', position: { x: inset + column * (width + gap), y },
        style: { width: `${width}px` }, data: { row, number: page.value * STORYBOARD_PAGE + i + column + 1 } })
    })
    y += Math.ceil(width * 9 / 16) + 60 + extra + gap
  }
  return { nodes, width: Math.max(screenWidth.value, (2 * inset + columns * width + (columns - 1) * gap) * scale), height: y * scale }
})
function syncViewport() { void flow.setViewport({ x: 0, y: 0, zoom: zoom.value }) }
watch(zoom, syncViewport, { flush: 'post' })
function changeZoom(direction: number) {
  const top = scroll.value?.scrollTop ?? 0
  const y = top > 0 ? layout.value.nodes.findLast(node => node.position.y * zoom.value <= top)?.position.y : undefined
  const anchor = y === undefined ? undefined : layout.value.nodes.find(node => node.position.y === y)
  zoom.value = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom.value + direction * .25))
  if (anchor) void nextTick(() => {
    const shot = layout.value.nodes.find(node => node.id === anchor.id)
    if (shot) scroll.value?.scrollTo(0, shot.position.y * zoom.value - 12)
  })
}
function rewind() { scroll.value?.scrollTo(0, 0) }
function fitWidth() { zoom.value = 1; rewind() }
function isCurrent(row: Shot) { return Math.abs(props.current - row.seconds) < 1e-8 && props.selectedId === (row.node?.id ?? props.model.root.id) }
watch(() => props.track, track => { if (!track) solo.value = false })
watch([interval, missing, solo, () => props.hidden, () => solo.value ? props.track?.id : undefined], () => { page.value = 0; rewind() })
watch(maxPage, max => { page.value = Math.min(max, page.value) })
watch(page, rewind)
function choose(row: { seconds: number; node: OtioNode | null }, monitor: boolean) {
  emit('position', row.seconds, row.node, solo.value, monitor)
}
</script>

<style scoped>
.storyboard { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: auto; }
.board-toolbar { flex: none; display: grid; gap: 4px; padding: 6px 12px 8px; background: var(--c-bg-soft); border-block-end: 1px solid var(--c-border); }
.board-primary, .board-view, .board-filters, .description-filter { display: flex; flex-wrap: wrap; align-items: center; }
.board-primary { justify-content: space-between; gap: 4px 12px; }
.board-view { margin-inline-start: auto; gap: 6px 12px; }
.shot-count { color: var(--c-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; }
.board-zoom { display: inline-flex; align-items: center; background: var(--c-bg-muted); border-radius: var(--radius-control); }
.board-action { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 0 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.board-action:hover:not(:disabled) { background: var(--c-bg-card); color: var(--c-text); }
.board-action:disabled { opacity: .48; cursor: not-allowed; }
.icon-action { min-width: 32px; }
.icon-action span { width: 15px; height: 15px; }
.fit-width { font-size: 12px; }
.board-filters { gap: 4px 14px; }
.board-filters label { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; min-width: 0; color: var(--c-text-secondary); font-size: 12px; }
.select-wrap { position: relative; display: inline-flex; min-width: 0; }
.select-wrap span { position: absolute; inset-inline-end: 6px; inset-block-start: 50%; width: 13px; height: 13px; transform: translateY(-50%); pointer-events: none; }
.select-wrap select { appearance: none; min-width: 0; max-width: 10rem; min-height: 32px; padding: 0 23px 0 8px; border: 0; border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-muted); font: inherit; text-overflow: ellipsis; }
.select-wrap select:hover:not(:disabled) { background: var(--c-bg-card); }
.select-wrap select:disabled { color: var(--c-text-muted); }
.description-filter input { margin: 0; accent-color: var(--c-primary-bg); }
.description-filter label:has(input:disabled) { color: var(--c-text-muted); }
.board-toolbar :is(button, select, input):focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.description-warning { display: flex; align-items: center; gap: 8px; margin: 2px 0 0; padding: 6px 8px; background: var(--c-warn-bg); color: var(--c-warn); font-size: 12px; }
.description-warning span { flex: none; }
.board-pagination { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 10px; background: var(--c-bg-soft); border-block-start: 1px solid var(--c-border); }
.board-scroll { flex: 1 0 96px; min-width: 0; overflow: auto; scrollbar-gutter: stable; background: var(--c-bg); }
.board-scroll:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.empty-board { padding: 18px 16px; margin: 0; color: var(--c-text-muted); }
.board-flow :deep(.vue-flow__pane) { touch-action: auto !important; }
.card { box-sizing: border-box; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); pointer-events: auto; }
.current-shot { border-color: var(--c-blue); box-shadow: 0 0 0 1px var(--c-blue); }
.sample { display: block; width: 100%; padding: 0; border: 0; background: transparent; color: inherit; text-align: start; }
.sample:hover .sample-name, .current-shot .shot-index { color: var(--c-primary); }
.sample:focus-visible, .caption:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.sample-meta { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 7px 10px 0; color: var(--c-text-muted); font: 11px/16px 'IBM Plex Mono', ui-monospace, monospace; font-variant-numeric: tabular-nums; }
.shot-index { font-weight: 600; }
.sample-name { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; padding: 2px 10px 10px; font-size: 14px; font-weight: 600; line-height: 19px; }
.caption { max-height: 57px; overflow: auto; margin: 0 10px; padding-block: 3px; border-top: 1px solid var(--c-border-soft); color: var(--c-text-body); font-size: 12px; line-height: 17px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
.caption-action { margin: 2px 8px 7px; color: var(--c-text-secondary); }
.description-editor { display: grid; gap: 5px; padding: 6px 10px; border-block-end: 1px solid var(--c-border); }
.description-editor textarea { display: block; width: 100%; }
.description-editor p { color: var(--c-error); margin: 0; }
</style>
