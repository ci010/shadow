<template>
  <section class="storyboard" :aria-label="t('Storyboard')">
    <header class="board-controls">
      <label>{{ t('Picture source') }} <select v-model="solo" class="input" :disabled="!track">
        <option :value="false">{{ t('Final timeline') }}</option>
        <option v-if="track" :value="true">{{ t('Solo: {name}', { name: track.name || t('Video track') }) }}</option>
      </select></label>
      <label>{{ t('Sampling') }} <select v-model="interval" class="input">
        <option :value="false">{{ t('Per visible shot') }}</option>
        <option :value="true">{{ t('Every 2 seconds') }}</option>
      </select></label>
      <label><input v-model="missing" type="checkbox" :disabled="!available"> {{ t('Missing descriptions only') }}</label>
    </header>
    <p class="description-scope" role="status">{{ available ? t('Descriptions are saved in this browser profile for this timeline revision. The OTIO file is unchanged.') : t('Local descriptions are unavailable for this preview.') }}</p>
    <form v-if="editing !== null && available" class="description-editor" @submit.prevent="save" @keydown.esc.stop="closeEditor">
      <label>{{ t('Shot description: {name}', { name: editingName }) }}
        <textarea ref="editor" v-model="text" class="input" :maxlength="DESCRIPTION_LIMIT" rows="2" />
      </label>
      <div><button class="btn btn-sm btn-primary" type="submit" :disabled="!active">{{ t('Save') }}</button>
        <button class="btn btn-sm" type="button" @click="closeEditor">{{ t('Cancel') }}</button></div>
      <p v-if="saveFailed" role="alert">{{ t('Description could not be saved to this browser.') }}</p>
    </form>
    <div v-if="rows.length" class="board-navigation">
      <span>{{ t('Shots {first}–{last} of {total}', { first: formatNumber(page * STORYBOARD_PAGE + 1), last: formatNumber(page * STORYBOARD_PAGE + rows.length), total: formatNumber(order.count) }) }}</span>
      <div class="board-zoom">
        <button class="btn btn-sm" type="button" :aria-label="t('Zoom out')" :disabled="zoom <= MIN_ZOOM" @click="changeZoom(-1)">−</button>
        <button class="btn btn-sm" type="button" :aria-label="t('Zoom in')" :disabled="zoom >= MAX_ZOOM" @click="changeZoom(1)">+</button>
        <button class="btn btn-sm" type="button" @click="fitWidth">{{ t('Fit width') }}</button>
      </div>
    </div>
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
    <footer v-if="order.count > STORYBOARD_PAGE" class="board-controls">
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
import OtioStoryboardPicture from './OtioStoryboardPicture.vue'

const props = defineProps<{ model: OtioModel; source: OtioDocument; apiBase: string; active: boolean; track?: OtioNode; hidden?: ReadonlySet<string>;
  mediaFor: (node: OtioNode) => (OtioMedium & { url: string }) | null; unlinked: string; current: number; selectedId: string }>()
const emit = defineEmits<{ position: [seconds: number, node: OtioNode | null, solo: boolean, monitor: boolean] }>()
const interval = ref(false), missing = ref(false), solo = ref(false), page = ref(0), scroll = ref<HTMLElement>()
const descriptions = shallowRef(new Map<string, string>()), available = ref(false), saveFailed = ref(false)
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
.board-controls { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 12px; padding: 6px 10px; background: var(--c-bg-soft); border-block-end: 1px solid var(--c-border); }
.board-controls label { display: inline-flex; gap: 5px; align-items: center; }
select { max-width: 190px; color: var(--c-text); background: var(--c-bg-input); border: 1px solid var(--c-control-border); }
.description-scope { color: var(--c-text-muted); margin: 0; padding: 5px 10px; font-size: 12px; }
.board-navigation { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; gap: 4px 12px; padding: 5px 12px; border-block: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 12px; }
.board-zoom { display: flex; align-items: center; gap: 4px; }
.board-zoom button { min-width: 24px; }
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
