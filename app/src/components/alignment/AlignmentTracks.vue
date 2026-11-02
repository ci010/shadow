<script setup lang="ts">
import AnnotationNoteTrack from './AnnotationNoteTrack.vue'
import { computed } from 'vue'
import { layoutAnnotationNotes, type AnnotationNote } from '../../annotation-notes.ts'
import { t, type MessageKey } from '../../i18n.ts'
import { editorWavePath as wavePath } from '../../alignment-editor.ts'
import { storyboardThumbnail, type StoryboardItem } from '../../alignment-storyboard.ts'
import type { AlignmentTarget } from '../../alignment-lab-model.ts'
import './alignment-controls.css'
const props = defineProps<{ notes?: AnnotationNote[]; selectedNoteId?: string; disabled?: boolean; items: StoryboardItem[]; timing: {id:string;start:number;end:number;duration:number}[]; chosen: string[]; targets: AlignmentTarget[]; samples: Float32Array; totalDuration: number; scale: number; playhead: number; isAudio: boolean; imported: boolean; scene: string; selectedTrack: string }>()
const emit = defineEmits<{ pointer: [event: PointerEvent, id?: string, edge?: 'left' | 'right']; track: [element: HTMLElement | null]; choose: [id: string]; move: [index: number, direction: -1 | 1]; select: [id: string]; noteChange: [value:{id:string;start:number;end:number}]; 'update:selectedTrack': [value: string] }>()
const noteItems=computed(()=>props.notes ?? props.targets.flatMap(target=>target.selector.type==='time-range' ? [{id:target.id,label:target.label,start:target.selector.start,end:target.selector.end}] : []))
const noteHeight=computed(()=>layoutAnnotationNotes(noteItems.value).rows*36+8)
function title(value: string) { return ['Arrival','The window','Reaction','Reveal'].includes(value) ? t(value as MessageKey) : value }
</script>
<template>    <div class="alignment-content timeline-layout" :class="{'source-audio':isAudio}"><div class="track-headers"><div class="time-label">{{ playhead.toFixed(2) }}</div><button v-if="!isAudio" @click="emit('update:selectedTrack', 'shot')" :class="{active:selectedTrack==='shot'}">V1 <span>{{ scene === 'audio' ? t('Reference') : t('Picture') }}</span></button><button @click="emit('update:selectedTrack', 'audio')" :class="{active:selectedTrack==='audio'}">A1 <span>{{ scene === 'audio' ? t('PCM tones') : t(imported ? 'Source audio' : 'No audio source') }}</span></button><button @click="emit('update:selectedTrack', 'intent')" :style="{height:`${noteHeight}px`}" :class="{active:selectedTrack==='intent'}">N1 <span>{{ t('Note track') }}</span></button></div><div class="timeline-scroll"><div :ref="element => emit('track', element as HTMLElement)" class="linear-track" :style="{width:`${totalDuration*scale}px`,height:`${(isAudio ? 160 : 198)+noteHeight}px`}"><div class="ruler" @pointerdown="emit('pointer', $event)"><span v-for="second in Math.floor(totalDuration)+1" :key="second" :style="{left:`${(second-1)*scale}px`}">{{ second-1 }}s</span></div><div v-for="(shot,index) in (isAudio ? [] : timing)" :key="shot.id" class="clip" :data-shot-id="shot.id" :class="{chosen:chosen.includes(shot.id)}" :style="{left:`${shot.start*scale}px`,width:`${shot.duration*scale}px`}"><button class="clip-body" :aria-label="title(items[index]!.title)" :aria-pressed="chosen.includes(shot.id)" @pointerdown="emit('pointer', $event, shot.id)" @click="emit('choose', shot.id)" @keydown.left.prevent="emit('move', index, -1)" @keydown.right.prevent="emit('move', index, 1)"><strong>{{ title(items[index]!.title) }}</strong><img :src="items[index]!.thumbnail ?? storyboardThumbnail(items[index]!.color,index)" alt=""><small>{{ shot.duration.toFixed(1) }} s</small></button><span class="edge left" @pointerdown.stop="emit('pointer', $event, shot.id, 'left')"></span><span class="edge right" @pointerdown.stop="emit('pointer', $event, shot.id, 'right')"></span></div><div class="audio-lane" :style="{width:`${totalDuration*scale}px`}"><svg v-if="isAudio" :viewBox="`0 0 ${totalDuration*scale} 60`" preserveAspectRatio="none"><path :d="wavePath(totalDuration*scale,samples)" /></svg><span v-else>{{ t(imported ? 'Audio follows source video' : 'Silent / no audio attached') }}</span></div><div class="intent-lane"><AnnotationNoteTrack :notes="noteItems" :duration="totalDuration" :scale="scale" :selected-id="selectedNoteId" :disabled="disabled" @select="emit('select',$event)" @change="emit('noteChange',$event)" /></div><div class="playhead" :style="{left:`${playhead*scale}px`}"></div></div></div></div></template>
<style scoped>
.timeline-layout{display:grid;grid-template-columns:110px minmax(0,1fr);background:var(--c-bg-soft)}
.track-headers{border-right:1px solid var(--c-border)}
.time-label{height:32px;padding:8px;color:var(--c-primary);font-family:monospace}
.track-headers button{display:block;width:100%;height:92px;border-radius:0;text-align:left;border-width:0 0 1px}
.track-headers button:nth-of-type(2){height:70px}
.track-headers button:nth-of-type(3){height:45px}
.track-headers button span{display:block;font-size:10px;color:var(--c-text-secondary);margin-top:8px}
.track-headers .active{box-shadow:inset 3px 0 var(--c-blue)}
.timeline-scroll{overflow:auto;min-width:0}
.linear-track{position:relative;height:239px;min-width:100%;background:repeating-linear-gradient(90deg,transparent 0,transparent 47px,#ffffff05 48px)}
.ruler{height:32px;position:absolute;inset:0 0 auto;cursor:crosshair;touch-action:none}
.ruler span{position:absolute;font:10px monospace;border-left:1px solid var(--c-border-hover);height:22px;padding:4px}
.clip{position:absolute;top:34px;height:86px;border:1px solid var(--c-selection-border);overflow:hidden;background:var(--c-selection-bg)}
.clip.chosen{outline:2px solid var(--c-blue);outline-offset:-2px;z-index:2}
.clip-body{width:100%;height:100%;padding:0!important;border:0!important;background:var(--c-selection-bg)!important;text-align:left;touch-action:none;cursor:grab!important}
.clip-body img{height:48px;width:100%;object-fit:cover;pointer-events:none;opacity:.85}
.clip-body strong,.clip-body small{display:block;padding:2px 8px;font-size:10px;white-space:nowrap;overflow:hidden}
.edge{position:absolute;top:0;bottom:0;width:7px;cursor:ew-resize;touch-action:none}
.left{left:0}
.right{right:0}
.audio-lane{position:absolute;top:124px;height:70px;width:100%;border-block:1px solid var(--c-border);background:var(--c-bg-muted);color:var(--c-text-secondary);padding:6px}
.audio-lane svg{width:100%;height:60px}
.audio-lane path,.audio-monitor path{stroke:var(--c-success);stroke-width:1;fill:none}
.intent-lane{position:absolute;top:198px;left:0;width:100%;padding:0}
.intent-lane button{white-space:nowrap;font-size:10px;background:var(--c-warn-bg)}
.playhead{position:absolute;top:0;bottom:0;width:1px;background:var(--c-error);pointer-events:none;z-index:3}
.playhead:before{content:'';position:absolute;left:-4px;border-top:8px solid var(--c-error);border-inline:4px solid transparent}
.timeline-layout{grid-template-columns:75px minmax(0,1fr)}
.source-audio .audio-lane{top:34px;height:120px;padding:24px 0;border:1px solid var(--c-success);box-sizing:border-box}
.source-audio .intent-lane{top:160px}
.source-audio .linear-track{height:205px}
.source-audio .track-headers button:nth-of-type(1){height:126px}
.source-audio .track-headers button:nth-of-type(2){height:45px}
.audio-lane{box-sizing:border-box;padding-inline:0}
.audio-lane svg{display:block}

.audio-lane{overflow:hidden;white-space:nowrap}
.intent-lane button{max-width:250px;overflow:hidden;text-overflow:ellipsis}
.timeline-layout{container-type:inline-size;color:var(--c-text);font-size:12px;min-width:0}.track-headers button{background:var(--c-bg-card);color:var(--c-text);border-color:var(--c-border);cursor:pointer}.clip-body{color:var(--c-text)}.clip-body strong{color:var(--c-primary)}.linear-track{background:var(--c-bg-soft)}.clip-body:focus-visible{outline:2px solid var(--c-blue);outline-offset:-3px}.intent-lane button{color:var(--c-warn);border:1px solid var(--c-border);min-height:28px}.ruler span{color:var(--c-text-secondary)}
@container(max-width:440px){.track-headers button span{font-size:11px}}

</style><style scoped>
.clip{transition:border-color 140ms ease,background-color 140ms ease}
.edge{transition:background-color 140ms ease}
@media(hover:hover){.clip:hover{border-color:var(--c-blue)}.edge:hover{background:var(--c-selection-border)}.ruler:hover{background:var(--c-bg-muted)}}
.edge:active{background:var(--c-blue)}.clip:has(.clip-body:active){border-color:var(--c-blue);cursor:grabbing}.clip-body:active{cursor:grabbing!important}
@media(prefers-reduced-motion:reduce){.clip,.edge{transition:none}}
</style>
