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
    <form v-if="editing !== null && available" class="description-editor" @submit.prevent="save">
      <label>{{ t('Shot description: {name}', { name: editingName }) }}
        <textarea v-model="text" class="input" :maxlength="DESCRIPTION_LIMIT" rows="2" />
      </label>
      <div><button class="btn btn-sm btn-primary" type="submit" :disabled="!active">{{ t('Save') }}</button>
        <button class="btn btn-sm" type="button" @click="editing = null">{{ t('Cancel') }}</button></div>
      <p v-if="saveFailed" role="alert">{{ t('Description could not be saved to this browser.') }}</p>
    </form>
    <div ref="scroll" class="board-scroll">
      <p v-if="!rows.length" class="description-scope">{{ missing ? t('No shots with missing descriptions.') : t('No storyboard pictures at this sampling.') }}</p>
      <ol v-else class="cards">
        <li v-for="row in rows" :key="row.seconds" class="card">
          <button type="button" class="sample" :aria-current="Math.abs(current - row.seconds) < 1e-8 && selectedId === (row.node?.id ?? model.root.id) ? 'true' : undefined"
            @click="choose(row, false)" @keydown.enter.prevent="choose(row, true)" @dblclick="choose(row, true)">
            <OtioStoryboardPicture :medium="row.medium" :seconds="row.position" :gap="!row.node" :active="active" :unlinked="unlinked" />
            <span class="sample-label"><span>{{ row.node ? row.node.name || t('Unnamed element') : t('No picture / gap') }}</span>
              <time>{{ t('{time} s', { time: formatNumber(row.seconds, { maximumFractionDigits: 3 }) }) }}</time></span>
          </button>
          <template v-if="row.node && row.caption">
            <p v-if="descriptions.has(row.node.id)" class="caption selectable-text">{{ descriptions.get(row.node.id) }}</p>
            <button v-if="available" class="btn btn-sm caption-action" type="button" :aria-label="t('Shot description: {name}', { name: row.node.name || t('Unnamed element') })" @click="edit(row.node)">
              {{ descriptions.has(row.node.id) ? t('Edit description') : t('Add description') }}
            </button>
          </template>
        </li>
      </ol>
    </div>
    <footer v-if="order.count > STORYBOARD_PAGE" class="board-controls">
      <button class="btn btn-sm" type="button" :disabled="!page" @click="page--">{{ t('Previous page') }}</button>
      <span>{{ t('Page {page} of {total}', { page: page + 1, total: maxPage + 1 }) }}</span>
      <button class="btn btn-sm" type="button" :disabled="page === maxPage" @click="page++">{{ t('Next page') }}</button>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
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
onMounted(() => window.addEventListener('storage', storage))
onBeforeUnmount(() => window.removeEventListener('storage', storage))
function edit(node: OtioNode) {
  editing.value = node.id; editingName.value = node.name || t('Unnamed element'); text.value = descriptions.value.get(node.id) ?? ''; saveFailed.value = false
}
function save() {
  const id = key.value, clip = editing.value
  if (!id || clip === null || !props.active || !available.value) return
  try {
    const next = readStoryboardDescriptions(localStorage, id), value = text.value.trim()
    if (value) next.set(clip, value.slice(0, DESCRIPTION_LIMIT)); else next.delete(clip)
    localStorage.setItem(id, JSON.stringify(Object.fromEntries(next)))
    descriptions.value = next; editing.value = null
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
watch(() => props.track, track => { if (!track) solo.value = false })
watch([interval, missing, solo, () => props.hidden, () => solo.value ? props.track?.id : undefined], () => { page.value = 0; if (scroll.value) scroll.value.scrollTop = 0 })
watch(maxPage, max => { page.value = Math.min(max, page.value) })
watch(page, () => { if (scroll.value) scroll.value.scrollTop = 0 })
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
.board-scroll { flex: 1 0 96px; overflow: auto; }
.cards { list-style: none; display: grid; grid-template-columns: repeat(auto-fill, minmax(min(150px, 100%), 1fr)); gap: 10px; margin: 0; padding: 8px 10px; }
.card { min-width: 0; border: 1px solid var(--c-border); background: var(--c-bg-card); }
.sample { width: 100%; padding: 0; text-align: start; }
.sample[aria-current] { outline: 2px solid var(--c-primary); outline-offset: -2px; position: relative; }
.sample-label { display: flex; justify-content: space-between; gap: 6px; padding: 6px; }
.sample-label span { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
time { white-space: nowrap; font-variant-numeric: tabular-nums; color: var(--c-text-muted); }
.caption { margin: 0; padding: 4px 6px; white-space: pre-wrap; overflow-wrap: anywhere; }
.caption-action { margin: 3px 6px; }
.description-editor { display: grid; gap: 5px; padding: 6px 10px; border-block-end: 1px solid var(--c-border); }
.description-editor textarea { display: block; width: 100%; }
.description-editor p { color: var(--c-error); margin: 0; }
</style>
