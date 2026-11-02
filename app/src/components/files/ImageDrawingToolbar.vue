<script setup lang="ts">
import { t } from '../../i18n.ts'
import type { ImageDrawingTool } from '../../image-drawing.ts'
import '../alignment/alignment-controls.css'
const props = withDefaults(defineProps<{ modelValue: ImageDrawingTool; tools?: ImageDrawingTool[]; disabled?: boolean; canUndo?: boolean }>(), { tools: () => ['freehand','line','rectangle','select'], disabled:false, canUndo:false })
const emit = defineEmits<{ 'update:modelValue': [tool: ImageDrawingTool]; undo: [] }>()
const labels = { freehand:'Freehand', line:'Straight line', rectangle:'Rectangle', select:'Select / inspect' } as const
function change(event: Event) { const tool=(event.target as HTMLSelectElement).value as ImageDrawingTool; if(props.tools.includes(tool)) emit('update:modelValue',tool) }
</script>
<template>
  <div class="alignment-content image-drawing-toolbar" role="group" :aria-label="t('Drawing tool')">
    <slot name="colors" />
    <label class="drawing-tool-label"><span>{{ t('Drawing tool') }}</span><select :value="modelValue" :disabled="disabled" :aria-label="t('Drawing tool')" @change="change"><option v-for="tool in tools" :key="tool" :value="tool">{{ t(labels[tool]) }}</option></select></label>
    <button class="btn image-drawing-select" type="button" :aria-pressed="modelValue==='select'" :disabled="disabled" @click="emit('update:modelValue','select')">{{ t('Select / inspect') }}</button>
    <button class="btn image-drawing-undo" type="button" :disabled="disabled || !canUndo" :aria-label="t('Undo last stroke')" @click="emit('undo')">{{ t('Undo') }}</button>
    <slot name="actions" />
    <p class="drawing-hint">{{ modelValue === 'freehand' || modelValue === 'line' ? t('Draw to mark · Shift-drag for a straight line') : modelValue === 'rectangle' ? t('Drag a rectangle on the image.') : t('Select an annotation to edit it. Choose a drawing tool to mark again.') }}</p>
  </div>
</template>
<style scoped>
.image-drawing-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;min-width:0}.drawing-tool-label{display:flex;align-items:center;gap:8px;font-size:12px}.drawing-hint{flex-basis:100%;margin:0;color:var(--c-text-secondary);font-size:12px;line-height:1.6}.drawing-tool-label select{max-width:100%}
@container(max-width:440px){.drawing-tool-label{flex-wrap:wrap}.drawing-tool-label>span{display:none}}
</style>
