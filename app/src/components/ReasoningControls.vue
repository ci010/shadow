<template>
  <div class="effort-options" role="group" aria-label="Reasoning effort">
    <button v-for="option in options" :key="option.value" type="button" class="setting-option effort-option"
      :disabled="disabled || busy" :aria-pressed="selected === option.value"
      @click="emit('change', reasoningSettingsForEffort(option.value))">
      <span class="setting-option-copy"><span>{{ option.label }}</span><small v-if="option.value === 'default' && inheritedSettings">Follow project · {{ currentEffort(inheritedSettings) }}</small><small v-else-if="option.description">{{ option.description }}</small></span>
      <span v-if="selected === option.value" class="setting-icon i-lucide-check" aria-hidden="true" />
    </button>
    <p v-if="!options.some(option => option.value === selected)" class="settings-note" role="status">The saved effort is not offered for this model. Select an available level or Default.</p>
    <p class="settings-note">Applies to this conversation. Available effort levels and no-thinking support depend on the model.</p>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { currentEffort, effortOptionsForModel, reasoningSettingsForEffort, type ReasoningSettings } from '../session-settings.ts'
const props = defineProps<{ settings: ReasoningSettings; inheritedSettings?: ReasoningSettings; model: string; disabled: boolean; busy?: boolean }>()
const emit = defineEmits<{ change: [patch: ReasoningSettings] }>()
const selected = computed(() => currentEffort(props.settings))
const options = computed(() => effortOptionsForModel(props.model))
</script>

<style scoped>
.setting-icon { display: inline-block; flex: 0 0 16px; width: 16px; height: 16px; }
.effort-options { min-height: 0; overflow-y: auto; }
.setting-option { display: flex; width: 100%; justify-content: space-between; align-items: center; gap: 12px; padding: 9px 10px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.setting-option-copy { display: flex; min-width: 0; flex-direction: column; gap: 3px; }
.setting-option-copy small { color: var(--c-text-secondary); font-size: 11px; line-height: 1.5; }
.setting-option:hover, .setting-option[aria-pressed="true"] { background: var(--c-bg-muted); }
.setting-option:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.settings-note { padding: 0 9px; color: var(--c-text-secondary); font-size: 11px; line-height: 1.6; }
.setting-option:disabled { opacity: .5; cursor: not-allowed; }
</style>
