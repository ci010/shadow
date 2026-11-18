<template>
  <span v-if="full || !instance" class="model-label" :class="{ full }">
    <span class="model-name">{{ model }}</span>
    <span v-if="instance" class="model-instance">@{{ instance }}</span>
  </span>
  <HoverInfo v-else class="model-anchor" :text="name" v-slot="{ triggerProps, open }">
    <button class="model-label model-trigger" type="button" v-bind="triggerProps" @click="open" :aria-label="t('Full model identifier: {name}', { name })">
      <span class="model-name">{{ model }}</span>
      <span class="model-instance">@{{ instance }}</span>
    </button>
  </HoverInfo>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
const props = defineProps<{ name: string; full: boolean }>()
// Usage preserves the recorded model@provider-instance key; split for display only.
const split = computed(() => props.name.lastIndexOf('@'))
const instance = computed(() => split.value > 0 ? props.name.slice(split.value + 1) : '')
const model = computed(() => instance.value ? props.name.slice(0, split.value) : props.name)
</script>
<style scoped>
.model-anchor, .model-label { display: block; min-width: 0; max-width: 100%; }
.model-trigger { width: 100%; padding: 0; border: 0; background: none; color: inherit; font: inherit; text-align: start; cursor: pointer; }
.model-trigger:hover .model-instance { text-decoration: underline; }
.model-trigger:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.model-name, .model-instance { display: block; overflow-wrap: anywhere; }
.model-name { font-weight: 600; }
.model-instance { font-size: 11px; color: var(--c-text-secondary); }
.model-trigger .model-name, .model-trigger .model-instance { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
@media (pointer: coarse) { .model-trigger { min-height: 44px; } }
</style>
