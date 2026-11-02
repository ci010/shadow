<script setup lang="ts">
import { t } from '../../i18n.ts'
import { useImageAlignment, type ImageAlignmentProps } from './useImageAlignment.ts'
import type { ImageAlignmentDocument } from '../../image-alignment.ts'
import ImageAlignmentCanvas from './ImageAlignmentCanvas.vue'
import ImageAnnotationInspector from './ImageAnnotationInspector.vue'
import AlignmentPanel from './AlignmentPanel.vue'
const props = defineProps<ImageAlignmentProps>()
const emit = defineEmits<{ apply: [document: ImageAlignmentDocument]; clear: [] }>()
const controller = useImageAlignment(props, emit)
const { ready, error, hasUnsavedChanges } = controller
defineExpose({ hasUnsavedChanges, flush: controller.reconcileRegions })
</script>
<template>
  <section class="alignment-panel" :aria-label="t('Image region instructions')" :aria-busy="!ready && !error">
    <p v-if="!compact" class="alignment-note">{{ t('Select where, describe what. These annotations express intent; the original image stays unchanged.') }}</p>
    <div v-if="error" role="alert"><p>{{ error }}</p><button class="btn" @click="controller.load">{{ t('Retry') }}</button></div>
    <p v-else-if="!ready" role="status">{{ t('Preparing image alignment…') }}</p>
    <div class="alignment-layout">
      <AlignmentPanel><ImageAlignmentCanvas :controller="controller" :file="file" :editable="editable" :active="active" /></AlignmentPanel>
      <AlignmentPanel><ImageAnnotationInspector :controller="controller" :editable="editable" :active="active" /><div v-if="$slots.details" class="alignment-extra"><slot name="details" /></div></AlignmentPanel>
    </div>
  </section>
</template>
<style scoped>
.alignment-panel{container-type:inline-size;color:var(--c-text);min-width:0}
.alignment-extra{margin-top:20px;padding-top:20px;border-top:1px solid var(--c-border)}
.alignment-note{font-size:12px;line-height:1.6;color:var(--c-text-secondary)}
.alignment-layout{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(0,1fr);gap:16px;align-items:start}
@container(max-width:680px){.alignment-layout{grid-template-columns:minmax(0,1fr)}}
</style>
