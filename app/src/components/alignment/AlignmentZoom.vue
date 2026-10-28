<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../../i18n.ts'
const props = withDefaults(defineProps<{ modelValue: number; min: number; max: number; step?: number; disabled?: boolean }>(), { step: 4, disabled: false })
const emit = defineEmits<{ 'update:modelValue': [value: number] }>()
const fill = computed(() => `${100 * (props.modelValue - props.min) / (props.max - props.min)}%`)
function update(value: number) { if (!props.disabled) emit('update:modelValue', Math.max(props.min, Math.min(props.max, value))) }
</script>
<template>
  <div class="alignment-zoom" :class="{ disabled }" role="group" :aria-label="t('Timeline zoom')">
    <span class="zoom-label">{{ t('Zoom') }}</span>
    <button type="button" class="zoom-minus" :aria-label="t('Zoom out')" :disabled="disabled || modelValue <= min" @click="update(modelValue - step)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10" /></svg></button>
    <input type="range" :aria-label="t('Timeline zoom')" :aria-valuetext="`${modelValue} px/s`" :min="min" :max="max" :step="step" :value="modelValue" :disabled="disabled" :style="{ '--zoom-fill': fill }" @input="update(Number(($event.target as HTMLInputElement).value))">
    <button type="button" class="zoom-plus" :aria-label="t('Zoom in')" :disabled="disabled || modelValue >= max" @click="update(modelValue + step)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10M8 3v10" /></svg></button>
    <output>{{ modelValue }} <span>px/s</span></output>
  </div>
</template>
<style scoped>
.alignment-zoom{display:inline-flex;align-items:center;gap:4px;color:inherit;font-size:12px;--zoom-accent:var(--c-blue,#7eb9e1)}.zoom-label{margin-right:5px;color:var(--c-text-secondary,#adb5c0)}.alignment-zoom button{display:grid;place-items:center;width:30px;height:30px;padding:6px;border:1px solid transparent;border-radius:4px;background:transparent;color:inherit;cursor:pointer}.alignment-zoom button:hover:not(:disabled){background:var(--c-bg-muted,#343940);border-color:var(--c-border,#474b52)}svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.5}.alignment-zoom input[type=range]{appearance:none;-webkit-appearance:none;width:100px;height:30px;min-height:30px;padding:0;margin:0 4px;border:0;border-radius:0;background:transparent;cursor:pointer;accent-color:var(--zoom-accent)}input::-webkit-slider-runnable-track{height:3px;border-radius:2px;background:linear-gradient(to right,var(--zoom-accent) 0 var(--zoom-fill),var(--c-border,#515965) var(--zoom-fill) 100%)}input::-moz-range-track{height:3px;border-radius:2px;background:var(--c-border,#515965)}input::-moz-range-progress{height:3px;background:var(--zoom-accent)}input::-webkit-slider-thumb{-webkit-appearance:none;width:11px;height:11px;margin-top:-4px;border:2px solid var(--zoom-accent);border-radius:50%;background:var(--c-bg-card,#282a2e)}input::-moz-range-thumb{width:8px;height:8px;border:2px solid var(--zoom-accent);border-radius:50%;background:var(--c-bg-card,#282a2e)}input:hover::-webkit-slider-thumb,input:active::-webkit-slider-thumb{background:var(--zoom-accent)}input:hover::-moz-range-thumb,input:active::-moz-range-thumb{background:var(--zoom-accent)}.alignment-zoom :is(button,input):focus-visible{outline:2px solid var(--zoom-accent);outline-offset:2px;border-radius:4px}.alignment-zoom button:disabled,.disabled{opacity:.42;cursor:default}.alignment-zoom input:disabled{cursor:default}output{min-width:66px;text-align:right;font-size:12px;font-variant-numeric:tabular-nums}output span{font-size:10px;color:var(--c-text-secondary,#adb5c0)}
</style>
