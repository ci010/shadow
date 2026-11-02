<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { t } from '../../i18n.ts'
import { adjustNoteRange, layoutAnnotationNotes, type AnnotationNote, type NoteEdit } from '../../annotation-notes.ts'
import './alignment-controls.css'
const props = defineProps<{ notes: readonly AnnotationNote[]; duration: number; scale: number; selectedId?: string; disabled?: boolean }>()
const emit = defineEmits<{ select: [id:string]; change: [value:{id:string;start:number;end:number}] }>()
const preview=ref<{id:string;start:number;end:number}>()
const layout=computed(()=>layoutAnnotationNotes(props.notes.map(note=>preview.value?.id===note.id ? {...note,...preview.value}:note)))
let release: (()=>void)|undefined
function cancel() { release?.();release=undefined;preview.value=undefined }
function pointer(event: PointerEvent, note: AnnotationNote, mode: NoteEdit) {
  if(props.disabled || event.button!==0 || !event.isPrimary || props.scale<=0 || !Number.isFinite(props.scale))return
  cancel();event.preventDefault();emit('select',note.id)
  const element=event.currentTarget as HTMLElement, x=event.clientX, scale=props.scale, duration=props.duration
  element.focus({preventScroll:true});element.setPointerCapture(event.pointerId)
  const move=(e:PointerEvent)=>{if(e.pointerId===event.pointerId) preview.value={id:note.id,...adjustNoteRange(note,mode,(e.clientX-x)/scale,duration)}}
  const finish=(e:PointerEvent)=>{if(e.pointerId!==event.pointerId)return;move(e);const value=preview.value;cancel();if(value && (value.start!==note.start || value.end!==note.end))emit('change',value)}
  const abort=()=>cancel()
  element.addEventListener('pointermove',move);element.addEventListener('pointerup',finish);element.addEventListener('pointercancel',abort);element.addEventListener('lostpointercapture',abort)
  release=()=>{element.removeEventListener('pointermove',move);element.removeEventListener('pointerup',finish);element.removeEventListener('pointercancel',abort);element.removeEventListener('lostpointercapture',abort);if(element.hasPointerCapture(event.pointerId))element.releasePointerCapture(event.pointerId)}
}
function key(event:KeyboardEvent,note:AnnotationNote,mode:NoteEdit){
  if(event.key==='Escape'){event.preventDefault();cancel();return}
  if(props.disabled || !['ArrowLeft','ArrowRight'].includes(event.key))return
  event.preventDefault();emit('select',note.id)
  emit('change',{id:note.id,...adjustNoteRange(note,mode,(event.key==='ArrowRight'?1:-1)*(event.shiftKey?1:.1),props.duration)})
}
watch(()=>[props.disabled,props.duration,props.scale],cancel)
watch(()=>props.notes.map(note=>note.id).join('|'),cancel)
onBeforeUnmount(cancel)
</script>
<template>
  <div class="alignment-content annotation-note-track" :style="{height:`${layout.rows*36+8}px`}" role="group" :aria-label="t('Note track')">
    <span v-if="!notes.length" class="empty-notes">{{ t('Add a Note to mark a time range.') }}</span>
    <div v-for="({note,row}) in layout.items" :key="note.id" class="note-clip" :class="{selected:selectedId===note.id,dragging:preview?.id===note.id}" :data-note-id="note.id" :style="{left:`${note.start*scale}px`,width:`${(note.end-note.start)*scale}px`,top:`${4+row*36}px`}">
      <button class="note-body" type="button" :aria-pressed="selectedId===note.id" :disabled="disabled" :title="`${note.description || note.label} · ${note.start.toFixed(2)}–${note.end.toFixed(2)} s`" @pointerdown="pointer($event,note,'move')" @click="emit('select',note.id)" @keydown="key($event,note,'move')"><strong>{{ note.description || note.label }}</strong><small>{{ note.start.toFixed(2) }}–{{ note.end.toFixed(2) }} s</small></button>
      <button class="note-edge note-start" type="button" :disabled="disabled" :aria-label="t('Adjust Note start')" @pointerdown.stop="pointer($event,note,'start')" @keydown="key($event,note,'start')" />
      <button class="note-edge note-end" type="button" :disabled="disabled" :aria-label="t('Adjust Note end')" @pointerdown.stop="pointer($event,note,'end')" @keydown="key($event,note,'end')" />
    </div>
  </div>
</template>
<style scoped>
.annotation-note-track{position:relative;min-width:0;background:var(--c-bg-soft);font-size:11px}.empty-notes{display:block;padding:10px;color:var(--c-text-secondary)}.note-clip{position:absolute;height:32px;box-sizing:border-box;border:1px solid var(--c-warn);background:var(--c-warn-bg);min-width:0;transition:border-color 140ms ease,background-color 140ms ease}.note-clip.selected{border-color:var(--c-blue);outline:1px solid var(--c-blue)}.note-body{display:grid!important;align-content:center;gap:0;min-height:0!important;width:100%;height:100%;padding:0 10px!important;border:0!important;color:var(--c-warn)!important;background:transparent!important;text-align:start;cursor:grab!important;touch-action:none;overflow:hidden}.note-body strong,.note-body small{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:10px;line-height:13px;font-weight:400}.note-body small{font-variant-numeric:tabular-nums}.note-edge{position:absolute;top:-1px;bottom:-1px;width:7px;min-height:0!important;padding:0!important;border:0!important;background:transparent!important;touch-action:none;cursor:ew-resize!important}.note-start{left:-1px}.note-end{right:-1px}.dragging .note-body{cursor:grabbing!important}.note-edge:focus-visible{outline:2px solid var(--c-blue);outline-offset:1px}.note-body:focus-visible{outline:2px solid var(--c-blue);outline-offset:-3px}@media(hover:hover){.note-clip:hover{border-color:var(--c-blue)}.note-edge:hover{background:var(--c-warn)!important}}@media(prefers-reduced-motion:reduce){.note-clip{transition:none}}
</style>
