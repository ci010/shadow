<template>
  <label v-if="selection" class="composer-model">
    <span>{{ selection.loading.value ? 'Loading models...' : 'Model' }}</span>
    <select
      :value="selection.current.value"
      :disabled="selection.disabled.value"
      :title="selection.current.value"
      aria-label="Model for new turns"
      @change="change"
    >
      <option v-for="model in selection.options.value" :key="model" :value="model">{{ model }}</option>
      <option v-if="selection.current.value && !selection.options.value.includes(selection.current.value)" :value="selection.current.value">{{ selection.current.value }}</option>
    </select>
  </label>
</template>

<script setup lang="ts">
import { useModelSelection } from '../model-selection.ts'

const selection = useModelSelection()
function change(event: Event) {
  if (event.target instanceof HTMLSelectElement) void selection?.select(event.target.value)
}
</script>

<style scoped>
.composer-model { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; color: var(--c-text-secondary); font-size: 12px; }
.composer-model span { flex-shrink: 0; }
select { min-width: 0; width: 240px; max-width: 100%; padding: 5px 8px; border: 1px solid var(--c-border); border-radius: 5px; background: var(--c-bg-input); color: var(--c-text); font: inherit; text-overflow: ellipsis; }
select:focus-visible { outline: 2px solid var(--c-success); outline-offset: 2px; }
@media (max-width: 900px) { select { width: 180px; } }
</style>
