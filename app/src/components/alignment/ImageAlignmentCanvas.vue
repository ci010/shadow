<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import ImageDrawingToolbar from '../files/ImageDrawingToolbar.vue'
import { t } from '../../i18n.ts'
import type { ImageAlignmentController } from './useImageAlignment.ts'
import './alignment-controls.css'
import '@annotorious/annotorious/annotorious.css'
const props = defineProps<{ controller: ImageAlignmentController; editable: boolean; active?: boolean; file?: File }>()
const { image, src, ready, error, feedback, regions, selected, drawing, tool, strokePoints, strokeSurface, asset, choose, setTool, undo, cancelGesture, strokeStart, strokeMove, strokeEnd, load } = props.controller
const previewRectangle = computed(() => {
  const a=strokePoints.value[0], b=strokePoints.value.at(-1)
  return a && b ? { x:Math.min(a[0],b[0]), y:Math.min(a[1],b[1]), width:Math.abs(b[0]-a[0]), height:Math.abs(b[1]-a[1]) } : undefined
})
const displaySize = ref({ width:0, height:0 })
const resize = new ResizeObserver(() => measure())
function measure() { const rect=image.value?.getBoundingClientRect(); if(rect) displaySize.value={ width:rect.width, height:rect.height } }
watch([image,ready], () => { resize.disconnect(); if(image.value) resize.observe(image.value); measure() }, { flush:'post' })
onBeforeUnmount(() => resize.disconnect())
const badges = computed(() => {
  const positions: {x:number;y:number}[] = [], size=displaySize.value, source=asset.value
  if(!source || !size.width) return positions
  for(const region of regions.value){
    const originX=Math.max(0,Math.min(size.width-26, region.x/source.width*size.width+3))
    let x=originX, y=Math.max(0,Math.min(size.height-26,region.y/source.height*size.height+3)), attempts=0
    while(positions.some(p=>Math.abs(p.x-x)<27 && Math.abs(p.y-y)<27) && attempts++<50){
      x+=28
      if(x>size.width-26){x=originX;y=Math.min(size.height-26,y+28)}
    }
    positions.push({x,y})
  }
  return positions
})
function isDot(points: [number,number][]) { const first=points[0]!; return points.every(p=>Math.hypot(p[0]-first[0],p[1]-first[1])<.5) }
</script>
<template>
  <div class="alignment-content alignment-visual">
    <p v-if="error" role="alert">{{ error }} <button class="btn" @click="load">{{ t('Retry') }}</button></p>
    <p v-else-if="!ready" role="status">{{ t('Preparing image alignment…') }}</p>
    <div class="alignment-controls"><ImageDrawingToolbar :model-value="tool" :disabled="!ready || !editable || !active" :can-undo="regions.length > 0" @update:model-value="setTool" @undo="undo" /></div>
    <div class="alignment-image-host" :class="{ 'is-loading': !ready }">
      <div class="alignment-source">
        <img ref="image" :src="src || undefined" :alt="file?.name || ''" draggable="false">
        <svg v-if="asset" ref="strokeSurface" class="stroke-surface" tabindex="0" :aria-label="t('Image drawing canvas')" :class="{ drawing: drawing && tool !== 'select' }" :viewBox="`0 0 ${asset.width} ${asset.height}`" @pointerdown="strokeStart" @pointermove="strokeMove" @pointerup="strokeEnd" @pointercancel="cancelGesture" @lostpointercapture="strokePoints.length && cancelGesture()">
          <g v-for="region in regions.filter(r => r.geometry?.type === 'stroke')" :key="region.id">
            <polyline :data-region-id="region.id" :points="region.geometry!.points.map(p => p.join(',')).join(' ')" :class="{ selected: selected === region.id }" :style="{ pointerEvents: drawing || !active ? 'none' : 'stroke' }" @pointerdown.stop="choose(region.id)" />
            <circle v-if="isDot(region.geometry!.points)" :cx="region.geometry!.points[0]![0]" :cy="region.geometry!.points[0]![1]" r="3" class="annotation-dot" :class="{ selected: selected === region.id }" :style="{ pointerEvents: drawing || !active ? 'none' : 'all' }" @pointerdown.stop="choose(region.id)" />
          </g>
          <rect v-if="tool === 'rectangle' && strokePoints.length && previewRectangle" v-bind="previewRectangle" class="drawing-preview" />
          <polyline v-else-if="strokePoints.length" :points="strokePoints.map(p => p.join(',')).join(' ')" class="selected drawing-preview" />
        </svg>
        <button v-for="(region,index) in regions" :key="region.id" type="button" class="annotation-number" :data-region-id="region.id" :aria-label="t('Region {number}', { number:index+1 })" :aria-pressed="selected===region.id" :disabled="!active" :style="{ left:`${badges[index]?.x ?? 0}px`, top:`${badges[index]?.y ?? 0}px`, pointerEvents:drawing ? 'none' : 'auto' }" @pointerdown.stop @click.stop="choose(region.id)">{{ index+1 }}</button>
      </div>
    </div>
    <p v-if="asset" class="alignment-coordinate">{{ t('Coordinates refer to the original {width} × {height} image.', { width:asset.width, height:asset.height }) }}</p>
    <p v-if="feedback" class="canvas-feedback" role="status">{{ feedback }}</p>
  </div>
</template>
<style scoped>
.alignment-visual{min-width:0}.alignment-controls{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:12px;font-size:12px}.alignment-controls select{max-width:100%}.alignment-source{position:relative;display:inline-block;max-width:100%;line-height:0;vertical-align:top}
.stroke-surface{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;overflow:visible}.stroke-surface.drawing{pointer-events:auto;touch-action:none;cursor:crosshair}.stroke-surface polyline{fill:none;stroke:var(--c-blue);stroke-width:3;stroke-linecap:round;stroke-linejoin:round;vector-effect:non-scaling-stroke;cursor:pointer}.stroke-surface polyline.selected{stroke-width:5}.drawing-preview{pointer-events:none;stroke:var(--c-blue);stroke-width:2;fill:var(--c-selection-bg);fill-opacity:.35;vector-effect:non-scaling-stroke}.annotation-dot{fill:var(--c-blue);cursor:pointer}.alignment-image-host{text-align:center;overflow:auto}.alignment-image-host.is-loading{height:0;overflow:hidden;visibility:hidden}.alignment-image-host img{max-width:100%;height:auto;object-fit:contain}.alignment-image-host :deep(.a9s-rotation-handle-group){display:none}.alignment-image-host :deep(.a9s-annotationlayer){touch-action:none}.alignment-coordinate,.canvas-feedback{font-size:12px;line-height:1.6;color:var(--c-text-secondary)}
.annotation-number{position:absolute;z-index:3;display:grid;place-items:center;min-height:24px!important;width:24px;height:24px;padding:0!important;margin:0;border:1px solid var(--c-bg-card)!important;border-radius:50%!important;background:var(--c-primary-bg)!important;color:var(--c-text-on-primary)!important;font-size:12px!important;font-weight:600;line-height:1;cursor:pointer;box-shadow:0 1px 3px var(--c-shadow-soft)}.annotation-number[aria-pressed=true]{outline:2px solid var(--c-blue);outline-offset:2px}.annotation-number:focus-visible{outline:2px solid var(--c-blue);outline-offset:3px}
.stroke-surface polyline{transition:stroke 140ms ease,stroke-width 140ms ease}@media(hover:hover){.stroke-surface:not(.drawing) polyline:hover{stroke-width:5}.annotation-number:hover{background:var(--c-primary-bg-hover)!important}}.stroke-surface.drawing polyline{transition:none}@media(prefers-reduced-motion:reduce){.stroke-surface polyline{transition:none}}
</style>
