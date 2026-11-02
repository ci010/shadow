<template>
  <div class="automation-conversation-settings chat-composer">
    <div class="automation-settings-box composer-box">
    <div v-if="job.canConfigureModel !== undefined" class="settings-row">
      <ModelSelector :conversation-defaults="true" :future-runs="true" :busy="saving" />
      <span>{{ t('This automation · Applies to future runs') }}</span>
    </div>
    <form v-if="job.source === 'learning' && job.intervalMs !== undefined" class="settings-row" @submit.prevent="saveInterval">
      <label class="interval-field">{{ t('interval (minutes)') }} <input v-model.number="minutes" type="number" min="1" max="35791" step="1" required :disabled="saving || !active || !job.editable || job.canToggle === false" /></label>
      <button class="btn btn-sm" :disabled="saving || !active || !job.editable || job.canToggle === false || minutes === job.intervalMs / 60000">{{ saving ? t('Saving...') : t('Save interval') }}</button>
    </form>
    <p v-if="error" role="alert">{{ error }}</p>
    <AutomationProfile :api-base="apiBase" :feature-id="job.id" :active="active" />
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { setAutomationInterval, setAutomationModel, type AutomationSummary } from '../automations.ts'
import { provideModelSelection, useModelSelection } from '../model-selection.ts'
import ModelSelector from './ModelSelector.vue'
import AutomationProfile from './AutomationProfile.vue'
const props = defineProps<{ apiBase: string; job: AutomationSummary; active: boolean }>()
const emit = defineEmits<{ saved: [] }>()
const parent = useModelSelection()
const model = ref(props.job.model ?? ''), saving = ref(false), error = ref('')
const minutes = ref(props.job.intervalMs === undefined ? 0 : props.job.intervalMs / 60000)
let mutation: AbortController | undefined
function reset() { mutation?.abort(); mutation = undefined; saving.value = false; error.value = '' }
watch(() => [props.apiBase, props.job.id, props.active], reset)
watch(() => [props.apiBase, props.job.id, props.job.model, props.job.intervalMs], () => {
  model.value = props.job.model ?? ''; minutes.value = (props.job.intervalMs ?? 0) / 60000
})
onUnmounted(reset)
async function saveInterval() {
  if (saving.value || !props.active || !props.job.editable || props.job.canToggle === false) return
  const controller = new AbortController(); mutation = controller
  saving.value = true; error.value = ''
  try {
    await setAutomationInterval(props.apiBase, props.job.id, minutes.value, controller.signal)
    if (!controller.signal.aborted) emit('saved')
  } catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Automations are unavailable. Retry.') }
  finally { if (mutation === controller) saving.value = false }
}
if (parent) provideModelSelection({
  ...parent,
  current: computed(() => model.value || props.job.defaultModel || ''),
  inherited: computed(() => props.job.defaultModel || ''),
  inheriting: computed(() => !model.value),
  disabled: computed(() => !props.job.canConfigureModel || saving.value || parent.loading.value || !!parent.error.value),
  select: async value => {
    if (!props.active || !props.job.canConfigureModel || saving.value) return
    const base = props.apiBase, id = props.job.id
    const controller = new AbortController(); mutation = controller
    saving.value = true; error.value = ''
    try {
      await setAutomationModel(base, id, value.trim() || null, controller.signal)
      if (!controller.signal.aborted && base === props.apiBase && id === props.job.id) { model.value = value.trim(); emit('saved') }
    } catch (cause) { if (!controller.signal.aborted && base === props.apiBase && id === props.job.id) error.value = cause instanceof Error ? cause.message : t('Automations are unavailable. Retry.') }
    finally { if (mutation === controller) saving.value = false }
  },
})
</script>
<style scoped>
.automation-conversation-settings { box-sizing: border-box; flex: 0 0 auto; min-width: 0; width: calc(100% - 40px); max-width: var(--conversation-max-width); margin: 12px auto 16px; font-size: 12px; }
/* Same surface and spacing as the regular chat input, without an editable input. */
.automation-settings-box { padding: 12px 12px 9px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-input); transition: border-color .15s ease; }
.automation-settings-box:focus-within, .automation-settings-box:has(.composer-control[aria-expanded="true"]) { border-color: var(--c-blue); }
.settings-row { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 12px; padding: 0 0 9px; }
.interval-field { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.interval-field input { width: 90px; min-height: 32px; border: 1px solid var(--c-control-border); background: var(--c-bg-input); color: var(--c-text); padding: 5px 8px; font: inherit; }
.interval-field input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { .interval-field input { min-height: 44px; } }
.settings-row > span { color: var(--c-text-secondary); }
.automation-settings-box :deep(.automation-profile) { padding: 9px 0 0; }
.automation-settings-box:has(.settings-row) :deep(.automation-profile) { border-top: 1px solid var(--c-border-soft); }
p { margin: 4px 0; color: var(--c-error); overflow-wrap: anywhere; }
@media (max-width: 700px) { .automation-conversation-settings { width: calc(100% - 24px); margin: 8px auto max(8px, env(safe-area-inset-bottom, 0px)); } .automation-settings-box { padding: 10px 12px 9px; } }
</style>
