<script setup lang="ts">
import { t } from '../../i18n.ts'
import type { ImageAlignmentController } from './useImageAlignment.ts'
import './alignment-controls.css'
const props = defineProps<{ controller: ImageAlignmentController; editable: boolean; active?: boolean; file?: File }>()
const { ready, feedback, regions, description, selected, hasUnsavedChanges, valid, choose, removeRegion, apply, clear, downloadJson } = props.controller
</script>
<template>
  <div class="alignment-content alignment-details">
    <header class="annotation-heading"><h3>{{ t('Local annotations') }}</h3><span>{{ regions.length }} / 50</span></header>
    <details class="overall-instructions" :open="!regions.length"><summary>{{ t('Overall change and constraints') }}</summary><textarea v-model="description" class="alignment-description" rows="3" maxlength="8000" :disabled="!ready || !editable" :aria-label="t('Overall change and constraints')" :placeholder="t('What should change? What must stay the same?')" /></details>
    <p v-if="!regions.length" class="alignment-note">{{ t('Draw on the image to add numbered annotations. Overlapping regions are supported.') }}</p>
    <ol class="alignment-regions">
      <li v-for="(region,index) in regions" :key="region.id" class="annotation-card" :class="{ selected:selected===region.id }" :data-region-id="region.id">
        <div class="annotation-card-heading"><button class="alignment-region" :aria-pressed="selected===region.id" @click="choose(region.id)"><span class="annotation-index">{{ index+1 }}</span><span class="annotation-identity"><strong>{{ t('Region {number}', { number:index+1 }) }}</strong><small>({{ Math.round(region.x) }}, {{ Math.round(region.y) }}) → ({{ Math.round(region.x+region.width) }}, {{ Math.round(region.y+region.height) }}) px</small></span></button><button type="button" class="annotation-delete" :aria-label="t('Delete annotation {number}', { number:index+1 })" :disabled="!editable" @click="removeRegion(region.id)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4h10M6 4V2h4v2M4 4l1 10h6l1-10M7 6v5M9 6v5" /></svg></button></div>
        <p v-if="selected!==region.id" class="annotation-summary">{{ region.description || t('Select to describe this annotation.') }}</p>
        <div v-else class="alignment-region-editor">
          <label>{{ t('Annotation description') }}<textarea v-model="region.description" class="alignment-region-description" rows="3" maxlength="4000" :disabled="!editable" :placeholder="t('Describe what you want to change here.')" /></label>
          <button class="btn alignment-remove" :disabled="!editable" @click="removeRegion(region.id)">{{ t('Remove region') }}</button>
        </div>
      </li>
    </ol>
    <p v-if="ready && !valid" class="alignment-note">{{ t('Describe the requested change before adding instructions.') }}</p>
    <div class="alignment-controls"><button class="btn alignment-apply" :disabled="!ready || !editable || !valid" @click="apply">{{ t('Add instructions to draft') }}</button><button class="btn alignment-clear" :disabled="!ready || !editable" @click="clear">{{ t('Clear instructions') }}</button><button class="btn" :disabled="!ready || !valid" @click="downloadJson">{{ t('Export instructions') }}</button></div>
    <p v-if="feedback" class="alignment-feedback" role="status">{{ feedback }}</p><p v-if="hasUnsavedChanges" class="alignment-note">{{ t('Unapplied instructions') }}</p>
  </div>
</template>
<style scoped>
.alignment-details{min-width:0;font-size:12px;line-height:1.6}.annotation-heading{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:12px}.annotation-heading h3{font-size:15px;line-height:20px;margin:0;font-weight:600}.annotation-heading>span{font-variant-numeric:tabular-nums;color:var(--c-text-secondary)}label{display:grid;gap:6px;margin-bottom:12px}input,textarea,select{width:100%;min-width:0}textarea{resize:vertical}.overall-instructions{margin-bottom:16px}.overall-instructions summary{cursor:pointer;padding:4px 0;color:var(--c-text-secondary)}.overall-instructions textarea{margin-top:8px}.alignment-regions{list-style:none;padding:0;margin:0 0 16px;display:grid;gap:10px}.annotation-card{border:1px solid var(--c-border);background:var(--c-bg-card);min-width:0;transition:border-color 140ms ease,background-color 140ms ease}.annotation-card.selected{border-color:var(--c-selection-border);background:var(--c-bg-soft)}.annotation-card-heading{display:flex;align-items:start;gap:4px;padding:8px}.alignment-region{display:flex;align-items:start;gap:8px;flex:1;min-width:0;min-height:36px;font:inherit;padding:0!important;text-align:start;border:0!important;background:transparent!important;color:var(--c-text);cursor:pointer}.annotation-index{display:grid;place-items:center;flex:0 0 24px;height:24px;border-radius:50%;background:var(--c-primary-bg);color:var(--c-text-on-primary);font-weight:600}.annotation-identity{display:grid;gap:2px;min-width:0}.annotation-identity strong{font-weight:500;overflow-wrap:anywhere}.annotation-identity small{font-size:11px;color:var(--c-text-secondary);font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.annotation-delete{display:grid;place-items:center;width:30px;height:32px;padding:6px;border:0;background:transparent;color:var(--c-text-secondary);cursor:pointer}.annotation-delete svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.3}.annotation-summary{margin:0;padding:0 12px 12px;white-space:pre-wrap;overflow-wrap:anywhere}.alignment-region-editor{padding:4px 12px 12px}.alignment-controls{display:flex;flex-wrap:wrap;gap:8px}.alignment-note,.alignment-feedback{color:var(--c-text-secondary)}@media(hover:hover){.annotation-card:hover{border-color:var(--c-border-hover)}.annotation-delete:hover{color:var(--c-error)}}@media(prefers-reduced-motion:reduce){.annotation-card{transition:none}}
</style>
