<script setup lang="ts">
import type { AnnotationNote } from '../../annotation-notes.ts'
import AlignmentZoom from './AlignmentZoom.vue'
import AlignmentPreview from './AlignmentPreview.vue'
import AlignmentTracks from './AlignmentTracks.vue'
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { editorWavePath as wavePath, editorDemoSamples, editorWaveThumbnail } from '../../alignment-editor.ts'
import { TIMELINE_MAX_BYTES, TIMELINE_MAX_DURATION, timelineDemoWav, timelineRange } from '../../alignment-timeline.ts'
import { t, type MessageKey }  from '../../i18n.ts'
import { alignmentRevision, type AlignmentSource, type AlignmentSurfaceProps, type AlignmentTarget } from '../../alignment-lab-model.ts'
import { storyboardTiming, moveStoryboardItem, storyboardSample, storyboardThumbnail, type StoryboardItem } from '../../alignment-storyboard.ts'
import { createUuid } from '../../uuid.ts'

const props = defineProps<AlignmentSurfaceProps>()
const emit = defineEmits<{ source: [source: AlignmentSource]; target: [target: AlignmentTarget]; select: [id: string]; remove: [id: string] }>()
function title(value: string) { return ['Arrival','The window','Reaction','Reveal'].includes(value) ? t(value as MessageKey) : value }
const selectedTrack = ref('shot')
const scene = ref('storyboard')
const audio = ref<HTMLAudioElement>()
const videoMedia = ref<HTMLVideoElement>()
const imported = ref(false), localMediaUrl = ref(''), localLabel = ref(''), sourceDuration = ref(12)
const samples = ref<Float32Array>(editorDemoSamples)
const isAudio = computed(() => scene.value === 'audio')
const isSourceMedia = computed(() => isAudio.value || imported.value)
const nativeMedia = () => imported.value && scene.value === 'video' ? videoMedia.value : audio.value
const audioUrl = URL.createObjectURL(new Blob([timelineDemoWav()], { type: 'audio/wav' }))
const rangeStart = ref(0), rangeEnd = ref(2)
const playing = ref(false)
let clock: ReturnType<typeof setInterval> | undefined
function pause() { playing.value = false; audio.value?.pause(); videoMedia.value?.pause(); if (clock) clearInterval(clock) }
async function toggle() {
  if (playing.value) return pause()
  if (isSourceMedia.value) {
    const media = nativeMedia(); if (!media) return
    try { if (playhead.value >= sourceDuration.value) playhead.value = 0; media.currentTime = playhead.value; await media.play(); playing.value = true } catch { error.value = t('Cannot decode or play this media. Try a smaller supported file.') }
    return
  }
  playing.value = true
  clock = setInterval(() => { if (!props.active || playhead.value >= totalDuration.value) { pause(); return }; playhead.value = Math.min(totalDuration.value, playhead.value + .05) }, 50)
}
function mediaTime(event: Event) { if (isSourceMedia.value) playhead.value = (event.target as HTMLMediaElement).currentTime }
function seek(time: number) { playhead.value = Math.max(0, Math.min(totalDuration.value,time)); if (isSourceMedia.value && nativeMedia()) nativeMedia()!.currentTime = playhead.value }
async function uploadMedia(event: Event) {
  const input = event.target as HTMLInputElement, file = input.files?.[0]; input.value = ''
  if (!file || busy.value) return
  if (file.size > TIMELINE_MAX_BYTES || !/^(audio|video)\//.test(file.type)) { error.value = t('Choose audio or video up to 40 MB.'); return }
  if (!allowReplacement()) return
  busy.value = true; error.value = ''; pause()
  const url = URL.createObjectURL(file), probe = document.createElement(file.type.startsWith('video/') ? 'video' : 'audio')
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const duration = await new Promise<number>((resolve,reject) => { probe.onloadedmetadata=()=>resolve(probe.duration); probe.onerror=()=>reject(new Error('decode')); timer=setTimeout(()=>reject(new Error('timeout')),15000); probe.src=url })
    if (!Number.isFinite(duration) || duration <= 0 || duration > TIMELINE_MAX_DURATION) throw new Error('duration')
    const revision = await alignmentRevision(file)
    let decoded = new Float32Array()
    if (file.type.startsWith('audio/')) { const context = new AudioContext(); try { const buffer = await context.decodeAudioData(await file.arrayBuffer()); decoded = new Float32Array(buffer.getChannelData(0)) } finally { await context.close() } }
    if (disposed) { URL.revokeObjectURL(url); return }
    urls.forEach(value=>URL.revokeObjectURL(value)); urls=[url]
    localMediaUrl.value=url; localLabel.value=file.name; sourceDuration.value=duration; imported.value=true; scene.value=file.type.startsWith('video/')?'video':'audio'; samples.value=decoded
    const item = { id: 'media-source', title:file.name, duration, color:'#34516b', detail:'', ...(decoded.length ? {thumbnail:editorWaveThumbnail(decoded)} : {thumbnail: `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><rect width="160" height="90" fill="#26333d"/><path d="M60 25l45 20-45 20z" fill="#9cbbd0"/></svg>')}`}) }
    items.value=[item]; assets.value=[item]; chosen.value=[]; playhead.value=0; rangeStart.value=0; rangeEnd.value=Math.min(2,duration)
    emit('source',{id:`media-${revision}`,label:file.name,revision,context:`Local ${file.type}; duration ${duration} source seconds; unchanged source playback. Bytes are not uploaded or attached.`})
  } catch { URL.revokeObjectURL(url); error.value=t('Cannot decode or play this media. Try a smaller supported file.') }
  finally { if(timer)clearTimeout(timer); probe.removeAttribute('src'); probe.load(); busy.value=false }
}
function switchScene(event: Event) { const el = event.target as HTMLSelectElement; const next = el.value; if (!allowReplacement()) { el.value = scene.value; return }; pause(); scene.value = next; void loadSample(true) }
function addRange(update = false) {
  if (busy.value) return
  try {
    const target=timelineRange(rangeStart.value,rangeEnd.value,totalDuration.value,scene.value==='audio'?'audio':'video',update && props.selectedId ? props.selectedId:createUuid(),`${t('Note')} ${rangeStart.value.toFixed(2)}–${rangeEnd.value.toFixed(2)} s`)
    if(target.selector.type==='time-range') target.selector.timeBasis=isSourceMedia.value?'source':'sequence'
    error.value='';selectedTrack.value='intent';emit('target',target)
  } catch {error.value=t('Range must be inside the sequence.')}
}
const notes=computed<AnnotationNote[]>(()=>props.targets.flatMap(target=>target.selector.type==='time-range' ? [{id:target.id,label:target.label,start:target.selector.start,end:target.selector.end,description:props.annotations?.find(annotation=>annotation.target.id===target.id)?.description}] : []))
function selectNote(id:string){pause();selectedTrack.value='intent';emit('select',id)}
function updateNote(value:{id:string;start:number;end:number}){
  const previous=props.targets.find(target=>target.id===value.id)
  if(!previous || previous.selector.type!=='time-range' || busy.value || !props.active)return
  try{
    const next=timelineRange(value.start,value.end,totalDuration.value,scene.value==='audio'?'audio':'video',value.id,`${t('Note')} ${value.start.toFixed(2)}–${value.end.toFixed(2)} s`)
    if(next.selector.type==='time-range')next.selector.timeBasis=previous.selector.timeBasis ?? (isSourceMedia.value?'source':'sequence')
    pause();rangeStart.value=value.start;rangeEnd.value=value.end;selectedTrack.value='intent';error.value='';emit('target',next)
  }catch{error.value=t('Range must be inside the sequence.')}
}
const selectedNote = computed(()=>notes.value.find(note=>note.id===props.selectedId))
function changeNoteDuration(event:Event){
  const input=event.target as HTMLInputElement, note=selectedNote.value, value=Number(input.value)
  if(!note || !input.value || !Number.isFinite(value) || value<=0 || note.start+value>totalDuration.value){error.value=t('Range must be inside the sequence.');if(note)input.value=String(note.end-note.start);return}
  updateNote({id:note.id,start:note.start,end:note.start+value})
}
function addNoteAtPlayhead(){rangeStart.value=Math.min(playhead.value,Math.max(0,totalDuration.value-.1));rangeEnd.value=Math.min(totalDuration.value,rangeStart.value+2);addRange()}
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
const timing = computed(() => imported.value ? [{id:'media-source',start:0,end:sourceDuration.value,duration:sourceDuration.value}] : storyboardTiming(items.value))
const totalDuration = computed(() => isSourceMedia.value ? sourceDuration.value : timing.value.at(-1)?.end ?? 0)
const selectedItems = computed(() => items.value.filter(item => chosen.value.includes(item.id)))
function selectItem(id: string) { if (isSourceMedia.value) { addRange(); return }; chosen.value = [id]; annotateSelection() }
function annotateSelection() {
  if (!chosen.value.length) return
  const ids = selectedItems.value.map(item => item.id)
  const existing = props.targets.find(target => target.selector.type === 'sequence' && !target.selector.proposedOrder && JSON.stringify(target.selector.itemIds) === JSON.stringify(ids))
  emit('target', { id: existing?.id ?? createUuid(), label: selectedItems.value.map(item => item.title).join(' · ').slice(0, 1000), selector: { type: 'sequence', itemIds: ids, shots: exportShots() } })
}
function refreshAnchors() {
  for (const target of props.targets) {
    if(target.selector.type==='time-range' && !isSourceMedia.value){
      const end=Math.min(target.selector.end,totalDuration.value),start=Math.min(target.selector.start,Math.max(0,end-Math.min(.1,totalDuration.value)))
      if(end>start)emit('target',{...target,selector:{...target.selector,start,end,duration:totalDuration.value,timeBasis:'sequence'}})
    }
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
async function loadSample(confirmed = false) {
  if (!confirmed && !allowReplacement()) return
  const ticket = ++generation
  busy.value = true
  try {
    pause(); imported.value=false; localMediaUrl.value=''; samples.value=editorDemoSamples; sourceDuration.value=12; selectedTrack.value=scene.value==='audio'?'audio':'shot'
    error.value = ''
    const sample = storyboardSample().map((item, index) => scene.value === 'audio' ? { ...item, title: [t('Tone 220 Hz'), t('Tone 330 Hz'), t('Tone 440 Hz')][index % 3]!, duration: 4, thumbnail: editorWaveThumbnail(editorDemoSamples.slice(index*64000,(index+1)*64000)) } : item).slice(0, scene.value === 'audio' ? 3 : 4)
    const context = JSON.stringify({ scene: scene.value, playback: scene.value === 'audio' ? 'Unmodified 12 second PCM source; source-second range annotations only' : scene.value === 'video' ? 'Simulated static-shot animatic; not decoded video' : 'Static storyboard', items: sample })
    const revision = await alignmentRevision(context)
    if (disposed || ticket !== generation) return
    urls.forEach(url => URL.revokeObjectURL(url)); urls = []
    assets.value = sample; playhead.value = 0; rangeStart.value=0; rangeEnd.value=2; items.value = sample; originalIds.value = sample.map(item => item.id); chosen.value = []
    emit('source', { id: 'sample-storyboard', label: scene.value === 'audio' ? t('Synthesized PCM · 12 seconds') : scene.value === 'video' ? t('Animatic · simulated video shots') : t('Four-shot story sample'), revision, context })
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
  if (target?.selector.type === 'time-range') { rangeStart.value=target.selector.start; rangeEnd.value=target.selector.end; seek(target.selector.start) }
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
  if (isSourceMedia.value) { rangeStart.value=imported.value ? 0 : assets.value.indexOf(asset)*4; rangeEnd.value=Math.min(rangeStart.value+asset.duration,totalDuration.value); addRange(); return }
  const item = { ...asset, id: createUuid(), sourceId: asset.id }
  items.value = [...items.value, item]; orderChanged(); selectItem(item.id)
}
function pointer(event: PointerEvent, id?: string, edge?: 'left' | 'right') {
  if (busy.value || event.button !== 0 || (id && isSourceMedia.value)) return
  event.preventDefault()
  const element = event.currentTarget as HTMLElement
  element.setPointerCapture(event.pointerId)
  const x = event.clientX, initial = items.value.map(item => ({ ...item }))
  const index = initial.findIndex(item => item.id === id)
  let moved = false
  const scrub = (e: PointerEvent) => {
    if (!track.value) return
    seek((e.clientX - track.value.getBoundingClientRect().left) / scale.value)
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
watch(() => props.active, value => { if (!value) pause() })
onMounted(() => loadSample(true))
onBeforeUnmount(() => { disposed = true; ++generation; pause(); URL.revokeObjectURL(audioUrl); urls.forEach(url => URL.revokeObjectURL(url)) })
</script>

<template>
  <section class="alignment-content editor" :aria-busy="busy" :aria-label="t('Unified editing workspace')">
    <header class="editor-tools"><strong>{{ t('EDIT') }} <span>{{ t('/ Quiet arrival') }}</span></strong><select :aria-label="t('Demo scene')" :value="scene" @change="switchScene"><option value="storyboard">{{ t('Storyboard · 4 shots') }}</option><option value="video">{{ t(imported && scene==='video' ? 'Local video source' : 'Video · simulated animatic') }}</option><option value="audio">{{ t(imported && isAudio ? 'Local audio source' : 'Audio · synthesized tones') }}</option></select><label class="import">{{ t('Import media') }}<input class="media-import" type="file" accept="audio/*,video/*" :disabled="busy" @change="uploadMedia"></label><label class="import">{{ t('Import images') }}<input type="file" accept="image/png,image/jpeg,image/webp" multiple @change="upload"></label></header>
    <div class="upper-panels">
      <aside class="media-pool"><h3>{{ t('MEDIA POOL') }} <span>{{ assets.length }} {{ t('sources') }}</span></h3><div class="bin-label">{{ t('▾ Master /') }} {{ t(scene as 'storyboard' | 'video' | 'audio') }}</div><button v-for="(asset,index) in assets" :key="asset.id" class="asset" @click="addAsset(asset)"><img :src="asset.thumbnail ?? storyboardThumbnail(asset.color,index)" alt=""><span>{{ title(asset.title) }}<small>{{ asset.duration.toFixed(1) }} s · {{ t(isSourceMedia ? 'Anchor range' : 'Add to sequence') }}</small></span></button><p>{{ t('Local sources · unchanged') }}</p></aside>
      <div class="viewer"><header>{{ t('PROGRAM') }} <span>{{ title(preview?.title ?? '') }}</span><output>{{ playhead.toFixed(2) }} s</output></header><AlignmentPreview :animating="scene === 'video' && playing"><video v-if="imported && scene==='video'" ref="videoMedia" :src="localMediaUrl" playsinline @timeupdate="mediaTime" @ended="pause" /><img v-else-if="preview && scene !== 'audio'" :src="preview.thumbnail ?? storyboardThumbnail(preview.color, originalIds.indexOf(preview.sourceId ?? preview.id))" :alt="preview.title"><div v-else class="audio-monitor"><svg viewBox="0 0 640 160"><path :d="wavePath(640,samples)" /></svg><strong>{{ t('PCM / MONO') }}</strong><span>{{ imported ? localLabel : t('16 kHz · 3 synthesized tones') }}</span></div></AlignmentPreview><div class="transport"><button @click="seek(0); pause()" :aria-label="t('Return to start')">|◀</button><button @click="toggle">{{ playing ? t('Pause') : t('Play') }}</button><output>{{ playhead.toFixed(2) }} / {{ totalDuration.toFixed(2) }}</output><span>{{ imported ? t('Source media · unchanged playback') : scene === 'storyboard' ? t('Static shot sequence') : scene === 'video' ? t('Simulated animatic · not decoded video') : t('Real local PCM playback') }}</span></div></div>
    </div>
    <div class="sequence-tools"><strong>{{ t('SEQUENCE 01') }}</strong><span>{{ totalDuration.toFixed(1) }} s</span><button class="add-note" :disabled="busy || !active" @click="addNoteAtPlayhead">{{ t('Add Note') }}</button><AlignmentZoom v-model="scale" :min="16" :max="120" :disabled="busy" /></div>
    <AlignmentTracks :notes="notes" :selected-note-id="selectedId" :disabled="busy || !active" :items="items" :timing="timing" :chosen="chosen" :targets="targets" :samples="samples" :total-duration="totalDuration" :scale="scale" :playhead="playhead" :is-audio="isAudio" :imported="imported" :scene="scene" v-model:selected-track="selectedTrack" @track="track = $event ?? undefined" @pointer="pointer" @choose="selectItem" @move="move" @select="selectNote" @note-change="updateNote" />
    <div class="edit-properties"><template v-for="item in (isSourceMedia ? [] : selectedItems)" :key="item.id"><strong>{{ title(item.title) }}</strong><label>{{ t('Duration') }} <input type="number" min=".1" max="600" step=".1" :value="item.duration" @change="changeDuration(item.id,$event)"></label><button @click="move(items.indexOf(item),-1)">{{ t('Earlier') }}</button><button @click="move(items.indexOf(item),1)">{{ t('Later') }}</button><button class="remove-clip" @click="removeClip(item.id)">{{ t('Remove clip') }}</button></template><label v-if="selectedNote">{{ t('Note duration') }} <input class="note-duration" type="number" :min="Math.min(.1,totalDuration)" step=".1" :value="Number((selectedNote.end-selectedNote.start).toFixed(3))" @change="changeNoteDuration"></label><label>{{ t('In') }} <input v-model.number="rangeStart" type="number" step=".1"></label><label>{{ t('Out') }} <input v-model.number="rangeEnd" type="number" step=".1"></label><button @click="addRange()">{{ t('Anchor range') }}</button><button v-if="targets.find(target=>target.id===selectedId)?.selector.type==='time-range'" @click="addRange(true)">{{ t('Update selected range') }}</button></div><p v-if="error" role="alert">{{ error }}</p><footer><span v-if="isSourceMedia">{{ t('Source media timeline · range annotations only') }}</span><span v-else>{{ t('Drag clips to reorder · edges ripple duration · ruler scrubs · proposals only, source unchanged') }}</span></footer><audio ref="audio" :src="imported && isAudio ? localMediaUrl : audioUrl" @timeupdate="mediaTime" @ended="pause" />
  </section>
</template>
<style scoped>
.editor{background:#202225;color:#d4d7dc;font-size:12px;min-width:0;--c-border:#3a3d42}.editor button,.editor select,.editor input{font:inherit;color:inherit;background:#303339;border:1px solid #474b52;border-radius:3px;padding:5px 8px}.editor button{cursor:pointer}.editor button:hover{background:#414750}.editor-tools,.sequence-tools,.edit-properties{display:flex;align-items:center;gap:12px;padding:10px 12px;border-bottom:1px solid #111;flex-wrap:wrap}.editor-tools strong{margin-right:auto;letter-spacing:1px}.editor-tools strong span{color:#8f959f;font-weight:400}.import{cursor:pointer}.import input{display:block;width:170px;font-size:10px}.upper-panels{display:grid;grid-template-columns:210px minmax(0,1fr);height:300px}.media-pool{border-right:4px solid #111;overflow:auto;padding:10px}.media-pool h3,.viewer header{font-size:10px;letter-spacing:1px;margin:0 0 10px}.media-pool h3 span{color:#8f959f;float:right;letter-spacing:0}.bin-label{padding:10px 0;color:#a8afb8}.media-pool .asset{display:flex;width:100%;gap:8px;margin-bottom:8px;padding:4px;text-align:left;background:#272a2e;border-color:#393c42}.asset img{width:65px;height:42px;object-fit:cover}.asset span{align-self:center;font-size:11px}.asset small{display:block;color:#9da5af;font-size:9px;margin-top:5px}.media-pool p{color:#969da7;font-size:10px}.viewer{display:flex;flex-direction:column;min-width:0;background:#141518}.viewer header{display:flex;padding:12px;background:#282a2e;margin:0;gap:20px}.viewer header span{color:#8f959f}.viewer output{margin-left:auto;font-variant-numeric:tabular-nums}.preview{margin:0;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#101113}.preview img{height:100%;max-width:100%;object-fit:contain}.animatic img{animation:drift 5s linear infinite alternate}@keyframes drift{to{transform:scale(1.09)}}.transport{display:flex;align-items:center;gap:10px;padding:10px;background:#25272b}.transport span{font-size:10px;color:#aab1ba;margin-left:auto}.sequence-tools{background:#2c2e33;height:45px}.sequence-tools strong{font-size:10px;letter-spacing:1px}.sequence-tools label{margin-left:auto;display:flex;align-items:center;gap:8px}.audio-monitor path{stroke:var(--c-success);stroke-width:1;fill:none}.edit-properties{font-size:10px;min-height:48px}.edit-properties input{width:60px}.edit-properties label{display:flex;gap:5px;align-items:center}.editor footer{padding:10px;color:#8f959f;font-size:10px;border-top:1px solid #383b41}.audio-monitor{width:80%;text-align:center;display:grid;gap:8px;color:#a1b7ab}.audio-monitor svg{width:100%;height:130px}button:focus-visible{outline:2px solid #e8bf74}@media(max-width:760px){.upper-panels{grid-template-columns:120px minmax(0,1fr);height:280px}.media-pool{padding:6px}.media-pool .asset{display:block}.asset img{width:100%}.asset small{display:none}.transport{flex-wrap:wrap}.transport span{width:100%}.editor-tools{gap:7px}.editor-tools strong{width:100%}.timeline-layout{grid-template-columns:75px minmax(0,1fr)}}
</style>
<style scoped>
.viewer{overflow:hidden}.viewer header,.transport{flex-shrink:0}.preview{flex:1 1 0;height:0}.preview img{min-height:0;max-height:100%}.sequence-tools{flex-shrink:0}
</style>

<style scoped>.preview video{height:100%;width:100%;object-fit:contain}.source-audio .audio-lane{top:34px;height:120px;padding:24px 0;border:1px solid #6c9e80;box-sizing:border-box}.source-audio .intent-lane{top:160px}.source-audio .linear-track{height:205px}.source-audio .track-headers button:nth-of-type(1){height:126px}.source-audio .track-headers button:nth-of-type(2){height:45px}.audio-lane{box-sizing:border-box;padding-inline:0}.audio-lane svg{display:block}.editor-tools .import input{width:140px}.media-pool .asset:disabled{opacity:1}.editor:has(.source-audio) .clip{display:none}</style>

<style scoped>.audio-lane{overflow:hidden;white-space:nowrap}.intent-lane button{max-width:250px;overflow:hidden;text-overflow:ellipsis}.intent-summary{font-size:12px}.editor-tools .import{font-size:11px}</style>

<style scoped>.sequence-tools :deep(.alignment-zoom){margin-left:auto}.editor-tools .import{position:relative;display:inline-flex;align-items:center;min-height:32px;box-sizing:border-box;padding:6px 10px;border:1px solid #474b52;border-radius:4px;background:#303339;font-size:12px}.editor-tools .import:hover{background:#414750}.editor-tools .import:focus-within{outline:2px solid #7eb9e1;outline-offset:2px}.editor-tools .import input{position:absolute;inset:0;opacity:0;width:100%;height:100%;cursor:pointer}.editor-tools .import:has(input:disabled){opacity:.45}.editor-tools{gap:8px}.editor-tools strong{letter-spacing:.06em}.editor :is(select,input[type=number]){min-height:32px;box-sizing:border-box}.edit-properties{font-size:12px;gap:8px}.edit-properties input{width:72px}.editor footer,.asset small,.track-headers button span,.transport span{font-size:11px}.media-pool{border-right-width:1px}.asset span{min-width:0;overflow-wrap:anywhere}.sequence-tools{height:auto;min-height:44px;box-sizing:border-box}.editor :is(button,input,select):focus-visible{outline:2px solid #7eb9e1;outline-offset:2px}.editor button:disabled{opacity:.45;cursor:default}@media(max-width:760px){.sequence-tools{gap:8px}.editor-tools select{max-width:100%}.sequence-tools :deep(.alignment-zoom){margin-left:0}.transport span{line-height:1.5}}</style>

<style scoped>.viewer>.alignment-preview{flex:1 1 0;height:0;aspect-ratio:auto}.editor{--c-bg:#202020;--c-bg-soft:#1a1a1a;--c-bg-card:#202020;--c-bg-input:#202020;--c-bg-muted:#292929;--c-text:#e7e7e7;--c-text-secondary:#b3b3b3;--c-primary:#8bb7ff;--c-blue:#8bb7ff;--c-selection-bg:#25334a;--c-selection-border:#456391;--c-success:#8dcca3;--c-error:#ef9b9b;--c-warn:#e4ba70;--c-warn-bg:#382d1c;--c-control-border:#808080;container-type:inline-size}.editor :is(button,input,select){border-radius:0}@container(max-width:600px){.upper-panels{grid-template-columns:110px minmax(0,1fr)}.asset img{width:100%}.media-pool .asset{display:block}.editor-tools{gap:8px}.transport{flex-wrap:wrap}}</style>
