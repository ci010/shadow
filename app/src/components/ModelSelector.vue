<template>
  <ComposerPopover v-if="selection" label="Choose model" :title="selection.current.value || 'Choose model'" :disabled="selection.disabled.value">
    <template #trigger>
      <span class="model-label">{{ selection.loading.value ? 'Loading models...' : modelDisplayName(selection.current.value) || 'Choose model' }}</span>
      <span class="model-chevron i-lucide-chevron-down" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div class="model-menu-heading"><span>Model</span><span class="model-scope">For new turns</span></div>
      <input v-model="query" class="model-search" type="search" placeholder="Search models..." aria-label="Search models" />
      <div class="model-options" role="group" aria-label="Available models">
        <button v-for="model in options" :key="model" class="model-option" :aria-pressed="model === selection.current.value" :title="model" @click="choose(model, close)">
          <span class="model-option-copy"><span>{{ modelDisplayName(model) }}</span><small v-if="modelProvider(model)">{{ modelProvider(model) }}</small></span>
          <span v-if="model === selection.current.value" class="model-check i-lucide-check" aria-hidden="true" />
        </button>
        <p v-if="!options.length" class="model-empty">No matching models.</p>
      </div>
      <p v-if="selection.error.value" class="model-error" role="alert">{{ selection.error.value }}</p>
    </template>
  </ComposerPopover>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ComposerPopover from './ComposerPopover.vue'
import { filterModelOptions, modelDisplayName, modelProvider, useModelSelection } from '../model-selection.ts'

const selection = useModelSelection()
const query = ref('')
const options = computed(() => filterModelOptions(selection?.options.value ?? [], selection?.current.value ?? '', query.value))
function choose(model: string, close: () => void) {
  close()
  query.value = ''
  void selection?.select(model)
}
</script>

<style scoped>
.model-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 260px; color: var(--c-text); }
.model-chevron { flex: 0 0 14px; width: 14px; height: 14px; }
.model-menu-heading { display: flex; justify-content: space-between; align-items: center; gap: 16px; padding: 8px 9px 12px; font-size: 13px; font-weight: 600; }
.model-scope { color: var(--c-text-secondary); font-size: 11px; font-weight: 400; }
.model-search { flex-shrink: 0; box-sizing: border-box; width: calc(100% - 8px); margin: 0 4px 8px; padding: 9px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; }
.model-options { overflow-y: auto; min-height: 0; max-height: 280px; }
.model-option { display: flex; align-items: center; justify-content: space-between; width: 100%; gap: 12px; padding: 9px 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); text-align: left; cursor: pointer; }
.model-option:hover, .model-option[aria-pressed="true"] { background: var(--c-bg-muted); }
.model-option-copy { display: flex; flex-direction: column; min-width: 0; gap: 3px; font-size: 13px; overflow-wrap: anywhere; }
.model-option small { color: var(--c-text-secondary); font-size: 11px; }
.model-check { flex-shrink: 0; width: 16px; height: 16px; }
.model-empty, .model-error { padding: 4px 10px; font-size: 12px; color: var(--c-text-secondary); }
.model-error { color: var(--c-error); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px) { .model-label { max-width: 180px; } }
</style>
