<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { t } from '../../i18n.ts'
import { alignmentRevision, type AlignmentSource, type AlignmentSurfaceProps, type AlignmentTarget } from '../../alignment-lab-model.ts'
import { storyboardTiming, moveStoryboardItem, storyboardSample, storyboardThumbnail, type StoryboardItem } from '../../alignment-storyboard.ts'
import { createUuid } from '../../uuid.ts'

const props = defineProps<AlignmentSurfaceProps>()
const emit = defineEmits<{ source: [source: AlignmentSource]; target: [target: AlignmentTarget]; select: [id: string]; remove: [id: string] }>()
const items = ref<StoryboardItem[]>(storyboardSample())
const chosen = ref<string[]>([])
const scale = ref(48)
const playhead = ref(0)
const assets = ref<StoryboardItem[]>(storyboardSample())
const track = ref<HTMLElement>()
const preview = computed(() => items.value[timing.value.findIndex(shot => playhead.value >= shot.start && playhead.value < shot.end)] ?? items.value.at(-1))
const busy = ref(false)
const error = ref('')
const originalIds = ref(items.value.map(item => item.id))
let urls: string[] = []
let generation = 0
let disposed = false
const timing = computed(() => storyboardTiming(items.value))
const totalDuration = computed(() => timing.value.at(-1)?.end ?? 0)
const selectedItems = computed(() => items.value.filter(item => chosen.value.includes(item.id)))
function selectItem(id: string) { chosen.value = [id]; annotateSelection() }
function annotateSelection() {
  if (!chosen.value.length) return
  const ids = selectedItems.value.map(item => item.id)
  const existing = props.targets.find(target => target.selector.type === 'sequence' && !target.selector.proposedOrder && JSON.stringify(target.selector.itemIds) === JSON.stringify(ids))
  emit('target', { id: existing?.id ?? createUuid(), label: selectedItems.value.map(item => item.title).join(' · ').slice(0, 1000), selector: { type: 'sequence', itemIds: ids, shots: exportShots() } })
}
function refreshAnchors() {
  for (const target of props.targets) {
    if (target.selector.type === 'sequence' && !target.selector.proposedOrder) {
      const ids = target.selector.itemIds.filter(id => items.value.some(item => item.id === id))
      if (!ids.length) emit('remove', target.id)
      else emit('target', { ...target, selector: { ...target.selector, itemIds: ids, shots: exportShots() } })
    }
  }
}
function changeDuration(id: string, event: Event) {
  const input = event.target as HTMLInputElement
  const duration = Number(input.value)
  if (!input.value || !Number.isFinite(duration) || duration < 0.1 || duration > 600) {
    error.value = t('Shot duration must be between 0.1 and 600 seconds.')
    input.value = String(items.value.find(item => item.id === id)!.duration)
    return
  }
  error.value = ''
  items.value = items.value.map(item => item.id === id ? { ...item, duration } : item)
  orderChanged()
}
function orderChanged() {
  try {
    const order = items.value.map(item => item.id)
    playhead.value = Math.min(playhead.value, totalDuration.value)
    refreshAnchors()
    emit('target', { id: 'sequence-order', label: t('Proposed shot order'), selector: { type: 'sequence', itemIds: order, proposedOrder: order, shots: exportShots() } })
  } catch { error.value = t('Could not update the shot order. Reset the sample and retry.') }
}
function move(index: number, direction: -1 | 1) {
  if (busy.value) return
  items.value = moveStoryboardItem(items.value, index, direction)
  orderChanged()
}
function allowReplacement() { return !(props.hasInstructions || props.targets.length) || window.confirm(t('Replace this source and discard its annotations?')) }
async function loadSample() {
  if (!allowReplacement()) return
  const ticket = ++generation
  busy.value = true
  try {
    error.value = ''
    const sample = storyboardSample()
    const context = JSON.stringify(sample)
    const revision = await alignmentRevision(context)
    if (disposed || ticket !== generation) return
    urls.forEach(url => URL.revokeObjectURL(url)); urls = []
    assets.value = sample; playhead.value = 0; items.value = sample; originalIds.value = sample.map(item => item.id); chosen.value = []
    emit('source', { id: 'sample-storyboard', label: t('Four-shot story sample'), revision, context })
  } catch { error.value = t('Could not prepare this source. Retry.') }
  finally { if (!disposed && ticket === generation) busy.value = false }
}
async function upload(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length || !allowReplacement()) return
  if (files.length > 24 || files.some(file => file.size > 20 * 1024 * 1024 || !/^image\/(png|jpeg|webp)$/.test(file.type))) {
    error.value = t('Choose up to 24 PNG, JPEG or WebP images, each under 20 MiB.'); return
  }
  const ticket = ++generation, created: string[] = []
  busy.value = true; error.value = ''
  try {
    const next: StoryboardItem[] = []
    for (const file of files) {
      const sha256 = await alignmentRevision(file)
      const url = URL.createObjectURL(file); created.push(url)
      next.push({ id: createUuid(), title: file.name, filename: file.name, sha256, detail: '', duration: 3, color: '#647c90', thumbnail: url })
    }
    const context = JSON.stringify(next.map(({ thumbnail, color, ...item }) => item))
    const revision = await alignmentRevision(context)
    if (disposed || ticket !== generation) { created.forEach(url => URL.revokeObjectURL(url)); return }
    urls.forEach(url => URL.revokeObjectURL(url)); urls = created
    assets.value = next; playhead.value = 0; items.value = next; originalIds.value = next.map(item => item.id); chosen.value = []
    emit('source', { id: 'local-image-collection', label: t('Local image collection'), revision, context })
  } catch { created.forEach(url => URL.revokeObjectURL(url)); error.value = t('Could not prepare this source. Retry.') }
  finally { if (!disposed && ticket === generation) busy.value = false }
}
watch(() => props.selectedId, id => {
  const target = props.targets.find(target => target.id === id)
  if (target?.selector.type === 'sequence' && !target.selector.proposedOrder) chosen.value = [...target.selector.itemIds]
})
watch(() => props.targets.some(target => target.id === 'sequence-order'), (has, previous) => {
  // Removing the order proposal restores the original arrangement, not the source files.
  if (previous && !has) {
    items.value = assets.value.map(item => ({ ...item }))
    refreshAnchors()
  }
})
function exportShots() { return timing.value.map(shot => ({ ...shot, sourceId: items.value.find(item => item.id === shot.id)!.sourceId ?? shot.id })) }
function removeClip(id: string) {
  if (items.value.length <= 1) return
  items.value = items.value.filter(item => item.id !== id); chosen.value = []; orderChanged()
}
function addAsset(asset: StoryboardItem) {
  const item = { ...asset, id: createUuid(), sourceId: asset.id }
  items.value = [...items.value, item]; orderChanged(); selectItem(item.id)
}
function pointer(event: PointerEvent, id?: string, edge?: 'left' | 'right') {
  if (busy.value || event.button !== 0) return
  event.preventDefault()
  const element = event.currentTarget as HTMLElement
  element.setPointerCapture(event.pointerId)
  const x = event.clientX, initial = items.value.map(item => ({ ...item }))
  const index = initial.findIndex(item => item.id === id)
  let moved = false
  const scrub = (e: PointerEvent) => {
    if (!track.value) return
    playhead.value = Math.max(0, Math.min(totalDuration.value, (e.clientX - track.value.getBoundingClientRect().left) / scale.value))
  }
  if (!id) scrub(event)
  const movePointer = (e: PointerEvent) => {
    const delta = (e.clientX - x) / scale.value
    if (Math.abs(e.clientX - x) > 3) moved = true
    if (!id) { scrub(e); return }
    if (edge) {
      const duration = Math.round(Math.max(.1, Math.min(600, initial[index]!.duration + delta * (edge === 'left' ? -1 : 1))) * 10) / 10
      items.value = initial.map(item => item.id === id ? { ...item, duration } : item)
    } else if (moved) {
      const start = storyboardTiming(initial)[index]!.start
      const found = storyboardTiming(initial).findIndex(shot => start + delta < (shot.start + shot.end) / 2)
      const destination = found < 0 ? initial.length - 1 : found
      const next = [...initial], [item] = next.splice(index, 1); next.splice(destination, 0, item!); items.value = next
    }
  }
  const finish = () => {
    element.removeEventListener('pointermove', movePointer); element.removeEventListener('pointerup', finish); element.removeEventListener('pointercancel', finish)
    if (id) { if (moved) orderChanged(); selectItem(id) }
  }
  element.addEventListener('pointermove', movePointer); element.addEventListener('pointerup', finish); element.addEventListener('pointercancel', finish)
}
onMounted(loadSample)
onBeforeUnmount(() => { disposed = true; ++generation; urls.forEach(url => URL.revokeObjectURL(url)) })
</script>

<template>
  <section class="storyboard-surface" :aria-label="t('Storyboard and reference collection')" :aria-busy="busy">
    <p class="surface-hint">{{ t('Drag clips to reorder; drag either edge to ripple duration. Select a clip to describe intent.') }}</p>
    <div class="surface-toolbar">
      <label class="file-control">{{ t('Load image collection') }}<input type="file" accept="image/png,image/jpeg,image/webp" multiple :disabled="busy" @change="upload"></label>
      <button class="btn" :disabled="busy" @click="loadSample">{{ t('Reset sample') }}</button>
      <label>{{ t('Timeline zoom') }} <input v-model.number="scale" type="range" min="16" max="120"></label>
    </div>
    <p v-if="error" role="alert">{{ error }}</p>
    <figure class="preview"><img v-if="preview" :src="preview.thumbnail ?? storyboardThumbnail(preview.color, originalIds.indexOf(preview.sourceId ?? preview.id))" :alt="preview.title"><figcaption>{{ t('Static shot preview — no video playback') }} · {{ playhead.toFixed(1) }} s · {{ preview?.title }}</figcaption></figure>
    <h3>{{ t('Proposed sequence') }} · {{ totalDuration.toFixed(1) }} s</h3>
    <p class="surface-hint">{{ t('This is proposed shot timing and order. Source files have not been changed.') }}</p>
    <label>{{ t('Playhead') }} <input v-model.number="playhead" class="scrubber" type="range" min="0" :max="totalDuration" step="0.1"></label>
    <div class="timeline-scroll">
      <div ref="track" class="linear-track" :style="{ width: `${totalDuration * scale}px` }">
        <div class="ruler" :aria-label="t('Scrub timeline')" @pointerdown="pointer($event)"><span v-for="second in Math.floor(totalDuration) + 1" :key="second" :style="{ left: `${(second - 1) * scale}px` }">{{ second - 1 }}s</span></div>
        <div v-for="(shot, index) in timing" :key="shot.id" class="clip" :data-shot-id="shot.id" :class="{ chosen: chosen.includes(shot.id) }" :style="{ left: `${shot.start * scale}px`, width: `${shot.duration * scale}px` }">
          <button class="clip-body" :aria-label="t('Select {name}', { name: items[index]!.title })" :aria-pressed="chosen.includes(shot.id)" @pointerdown="pointer($event, shot.id)" @click="selectItem(shot.id)" @keydown.left.prevent="move(index, -1)" @keydown.right.prevent="move(index, 1)"><img :src="items[index]!.thumbnail ?? storyboardThumbnail(items[index]!.color, originalIds.indexOf(items[index]!.sourceId ?? shot.id))" alt=""><strong>{{ items[index]!.title }}</strong><small>{{ shot.duration.toFixed(1) }}s</small></button>
          <span class="edge left" :title="t('Resize duration')" @pointerdown.stop="pointer($event, shot.id, 'left')"></span><span class="edge right" :title="t('Resize duration')" @pointerdown.stop="pointer($event, shot.id, 'right')"></span>
        </div>
        <div class="playhead" :style="{ left: `${playhead * scale}px` }"></div>
      </div>
    </div>
    <div v-for="item in selectedItems" :key="item.id" class="surface-toolbar selection-actions">
      <strong>{{ item.title }}</strong><button class="btn remove-clip" :disabled="items.length <= 1" @click="removeClip(item.id)">{{ t('Remove clip') }}</button><label>{{ t('Shot duration (seconds)') }} <input type="number" min="0.1" max="600" step="0.1" :value="item.duration" :aria-label="t('Duration for {name}', { name: item.title })" @change="changeDuration(item.id, $event)"></label>
      <button class="btn" :disabled="items[0]?.id === item.id" @click="move(items.indexOf(item), -1)">{{ t('Move earlier') }}</button><button class="btn" :disabled="items.at(-1)?.id === item.id" @click="move(items.indexOf(item), 1)">{{ t('Move later') }}</button>
    </div>
    <h3>{{ t('Source assets — add to sequence') }}</h3>
    <div class="asset-bin"><button v-for="(asset, index) in assets" :key="asset.id" class="asset" :disabled="busy || items.length >= 100" @click="addAsset(asset)"><img :src="asset.thumbnail ?? storyboardThumbnail(asset.color, index)" alt=""><span>＋ {{ asset.title }}</span></button></div>
  </section>
</template>
<style scoped>
.storyboard-surface { min-width: 0; } .surface-hint, figcaption { font-size: 12px; color: var(--c-text-secondary); line-height: 1.6; }
.surface-toolbar { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; margin: 12px 0; font-size: 12px; } input[type=number] { width: 80px; } input[type=file] { max-width: 220px; }
.preview { margin: 12px 0; background: var(--c-bg-muted); text-align: center; } .preview img { height: 190px; width: 100%; object-fit: contain; } .scrubber { width: min(100%, 400px); }
.timeline-scroll { overflow-x: auto; padding: 8px 2px; border: 1px solid var(--c-border); } .linear-track { position: relative; height: 150px; } .ruler { position: absolute; inset: 0 0 auto; height: 30px; cursor: crosshair; touch-action: none; } .ruler span { position: absolute; font-size: 10px; border-left: 1px solid var(--c-border); padding-left: 2px; pointer-events: none; }
.clip { position: absolute; top: 32px; height: 108px; box-sizing: border-box; border: 2px solid var(--c-border); overflow: hidden; } .clip.chosen { border-color: var(--c-blue); } .clip-body { width: 100%; height: 100%; padding: 0; border: 0; background: var(--c-bg-muted); color: var(--c-text); cursor: grab; touch-action: none; text-align: left; overflow: hidden; } .clip-body img { width: 100%; height: 65px; object-fit: cover; pointer-events: none; } .clip-body strong, .clip-body small { display: block; padding: 0 9px; white-space: nowrap; font-size: 11px; }
.edge { position: absolute; top: 0; bottom: 0; width: 8px; background: #88aacc55; cursor: ew-resize; touch-action: none; } .left { left: 0; } .right { right: 0; } .playhead { position: absolute; top: 0; bottom: 0; width: 2px; background: #ef6351; pointer-events: none; }
.asset-bin { display: flex; gap: 10px; overflow-x: auto; } .asset { flex: 0 0 120px; background: var(--c-bg-muted); color: var(--c-text); border: 1px solid var(--c-border); cursor: pointer; } .asset img { width: 100%; height: 65px; object-fit: cover; } .asset span { display: block; font-size: 12px; } button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); }
</style>
