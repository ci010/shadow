<script setup lang="ts">
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { createUuid } from '../../uuid.ts'
import type { AnnotationNote } from '../../annotation-notes.ts'
import { t } from '../../i18n.ts'
import AlignmentPanel from './AlignmentPanel.vue'
import AlignmentToolbar from './AlignmentToolbar.vue'
import AlignmentPreview from './AlignmentPreview.vue'
import AlignmentTracks from './AlignmentTracks.vue'
import AlignmentZoom from './AlignmentZoom.vue'
import ImageAlignmentCanvas from './ImageAlignmentCanvas.vue'
import ImageAnnotationInspector from './ImageAnnotationInspector.vue'
import ImagePromptDetails from './ImagePromptDetails.vue'
import { useImageAlignment } from './useImageAlignment.ts'
import type { LibraryImage } from '../../image-library.ts'
import type { ImageAlignmentDocument } from '../../image-alignment.ts'
import { moveStoryboardItem, storyboardSample, storyboardThumbnail, storyboardTiming } from '../../alignment-storyboard.ts'
const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 600
const ctx = canvas.getContext('2d')!
ctx.fillStyle = '#d9e1d7'; ctx.fillRect(0,0,960,600)
ctx.fillStyle = '#779385'; ctx.fillRect(80,80,330,390)
ctx.fillStyle = '#eaf0e7'; ctx.fillRect(100,100,290,350)
ctx.fillStyle = '#779385'; ctx.fillRect(240,100,10,350); ctx.fillRect(100,270,290,10)
ctx.fillStyle = '#a27d60'; ctx.fillRect(490,350,360,30); ctx.fillRect(520,380,20,160); ctx.fillRect(800,380,20,160)
const file = new File([Uint8Array.from(atob(canvas.toDataURL().split(',')[1]!), c => c.charCodeAt(0))], 'composition-room.png', { type:'image/png' })
const image = reactive<LibraryImage>({ id:'composition-room', file, url:URL.createObjectURL(file), prompt:'', keywords:[], demo:true, visited:true })
const independent = reactive<LibraryImage>({ ...image, id:'independent', prompt:'Independent notes', keywords:['reference'] })
const applied = ref<ImageAlignmentDocument>()
function emit(event: 'apply' | 'clear', document?: ImageAlignmentDocument) { applied.value = event === 'apply' ? document : undefined }
const controller = useImageAlignment({ file, editable:true, active:true }, emit)
const mode = ref('side')
const items = ref(storyboardSample()), chosen = ref<string[]>([]), scale = ref(48), playhead = ref(0), selectedTrack = ref('shot')
const timing = computed(() => storyboardTiming(items.value))
const duration = computed(() => timing.value.at(-1)?.end ?? 0)
const preview = computed(() => items.value[timing.value.findIndex(shot => playhead.value >= shot.start && playhead.value < shot.end)] ?? items.value.at(-1)!)
const track = ref<HTMLElement>()
const selectedNoteId = ref('demo-note')
const notes = ref<AnnotationNote[]>([{id:'demo-note',label:'Note',description:'Example note',start:1,end:3}])
function updateNote(value:{id:string;start:number;end:number}){notes.value=notes.value.map(note=>note.id===value.id?{...note,...value}:note)}
function addNote(){const start=Math.min(playhead.value,Math.max(0,duration.value-.1));const note={id:createUuid(),label:t('Note'),description:'',start,end:Math.min(duration.value,start+2)};notes.value.push(note);selectedNoteId.value=note.id}
const samples = new Float32Array()
function pointer(event: PointerEvent, id?: string) {
  if (id) { chosen.value=[id]; return }
  if (!track.value) return
  const element = event.currentTarget as HTMLElement
  element.setPointerCapture(event.pointerId)
  const seek = (e: PointerEvent) => { if(track.value) playhead.value = Math.max(0,Math.min(duration.value,(e.clientX-track.value.getBoundingClientRect().left)/scale.value)) }
  seek(event)
  const finish = () => { element.removeEventListener('pointermove',seek);element.removeEventListener('pointerup',finish);element.removeEventListener('pointercancel',finish) }
  element.addEventListener('pointermove',seek);element.addEventListener('pointerup',finish);element.addEventListener('pointercancel',finish)
}
onBeforeUnmount(() => URL.revokeObjectURL(image.url))
</script>
<template>
  <main class="composition-lab">
    <header><h1>{{ t('Component compositions') }}</h1><a href="?view=image">{{ t('Alignment Lab') }}</a><p>{{ t('One component, different containers. Layout belongs to the host.') }}</p></header>
    <AlignmentToolbar><label>{{ t('Composition layout') }} <select v-model="mode" class="composition-mode"><option value="side">{{ t('Side by side') }}</option><option value="stack">{{ t('Stacked') }}</option><option value="narrow">{{ t('Narrow container') }}</option></select></label></AlignmentToolbar>
    <section class="composition-grid" :class="mode" data-composition="image">
      <AlignmentPanel :title="t('Image preview')"><ImageAlignmentCanvas :controller="controller" :file="file" :editable="true" :active="true" /></AlignmentPanel>
      <AlignmentPanel><ImageAnnotationInspector :controller="controller" :editable="true" :active="true" /></AlignmentPanel>
      <AlignmentPanel><ImagePromptDetails :image="image" controlled @update="Object.assign(image,$event)" /></AlignmentPanel>
    </section>
    <section class="comparison-grid">
      <AlignmentPanel class="shared-prompt"><ImagePromptDetails :image="image" controlled @update="Object.assign(image,$event)" /></AlignmentPanel>
      <AlignmentPanel class="independent-prompt"><ImagePromptDetails :image="independent" controlled @update="Object.assign(independent,$event)" /></AlignmentPanel>
    </section>
    <AlignmentPanel :title="t('Timeline composition')" class="timeline-composition">
      <AlignmentToolbar><button class="btn" @click="addNote">{{ t('Add Note') }}</button><AlignmentZoom v-model="scale" :min="16" :max="120" /><output>{{ playhead.toFixed(2) }} s</output></AlignmentToolbar>
      <div class="timeline-preview"><AlignmentPreview><img :src="storyboardThumbnail(preview.color,items.indexOf(preview))" :alt="preview.title" /></AlignmentPreview></div>
      <AlignmentTracks :notes="notes" :selected-note-id="selectedNoteId" @note-change="updateNote" @select="selectedNoteId=$event" :items="items" :timing="timing" :chosen="chosen" :targets="[]" :samples="samples" :total-duration="duration" :scale="scale" :playhead="playhead" :is-audio="false" :imported="false" scene="storyboard" v-model:selected-track="selectedTrack" @track="track=$event ?? undefined" @pointer="pointer" @choose="chosen=[$event]" @move="(index,direction)=>items=moveStoryboardItem(items,index,direction)" />
      <p>{{ t('Composition demo: selection, keyboard ordering, zoom and scrub. Full clip editing is in the workspace.') }}</p>
    </AlignmentPanel>
    <details v-if="applied"><summary>{{ t('Export JSON') }}</summary><pre>{{ JSON.stringify(applied,null,2) }}</pre></details>
  </main>
</template>
<style scoped>
.composition-lab{padding:24px;max-width:1600px;margin:auto;color:var(--c-text);font-size:13px;line-height:1.6;background:var(--c-bg)}.composition-lab header{margin-bottom:20px}.composition-lab h1{font-size:24px;font-weight:600;margin:0 0 8px}.composition-lab p{color:var(--c-text-secondary)}.composition-grid{display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr) minmax(0,1fr);gap:16px;margin-block:16px;align-items:start}.composition-grid.stack{grid-template-columns:minmax(0,1fr)}.composition-grid.narrow{grid-template-columns:minmax(0,320px);justify-content:start}.comparison-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,320px);gap:16px;margin-block:24px;align-items:start}.timeline-preview{max-width:440px;margin-block:16px}.composition-lab :deep(.alignment-surface){overflow-wrap:anywhere}.composition-lab pre{white-space:pre-wrap;overflow-wrap:anywhere}.composition-lab>.alignment-toolbar{padding:8px 0}@media(max-width:850px){.composition-grid.side,.comparison-grid{grid-template-columns:minmax(0,1fr)}.composition-lab{padding:12px}} 
</style>
