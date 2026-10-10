<template>
  <form class="model-defaults-form" @submit.prevent="save" @input="notice = ''" @change="notice = ''">
    <h2>{{ t('Model defaults') }}</h2>
    <p class="settings-help">{{ t('Leave a setting unset to follow') }} {{ parentLabel }}{{ t('. Explicit project and conversation choices take priority. Changes apply to the next turn, not a running response.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading model defaults...') }}</p>
    <p v-if="error" class="settings-error" role="alert">{{ error }} <button type="button" class="btn btn-sm" :disabled="loading || saving" @click="load">{{ t('Reload defaults') }}</button></p>
    <fieldset :disabled="loading || saving || !state">
      <label class="settings-field">{{ t('Default model') }}
        <UiCombobox v-model="model" :options="models" :placeholder="t('Follow {parentLabel}: {value2}', { parentLabel: parentLabel, value2: state?.inherited.model ?? '' })" />
      </label>
      <p v-if="modelsError" class="settings-error" role="alert">{{ modelsError }}</p>
      <label class="settings-field">{{ t('Default effort') }}
        <UiSelect v-model="effort">
          <option v-for="option in effortOptionsForModel(model || state?.inherited.model || '')" :key="option.value" :value="option.value">{{ option.value === 'default' ? t('Follow {parentLabel} · {inheritedEffort}', { parentLabel: parentLabel, inheritedEffort: inheritedEffort }) : option.label }}</option>
        </UiSelect>
      </label>
      <label class="settings-field">{{ t('Temperature') }}
        <input v-model="temperature" type="number" step="0.1" :placeholder="t('Follow {parentLabel}: {value2}', { parentLabel: parentLabel, value2: state?.inherited.temperature ?? '' })" />
      </label>
      <div class="settings-actions">
        <button class="btn save-defaults" type="submit">{{ saving ? t('Saving...') : t('Save model defaults') }}</button>
        <button class="btn" type="button" @click="model = ''; effort = 'default'; temperature = ''; notice = ''">{{ t('Use inherited values') }}</button>
      </div>
    </fieldset>
    <p v-if="state" class="settings-help">{{ t('Effective now:') }} {{ state.model }} · {{ currentEffort(state) }} {{ t('effort.') }}</p>
    <p v-if="notice" class="settings-help" role="status">{{ notice }}</p>
  </form>
</template>

<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import UiCombobox from './UiCombobox.vue'
import { t } from '../i18n.ts'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { createModelDefaultsClient, type ModelDefaultsState } from '../model-defaults.ts'
import { createProjectSettingsClient } from '../project-settings.ts'
import { currentEffort, effortOptionsForModel, reasoningSettingsForEffort, type EffortChoice } from '../session-settings.ts'

const props = defineProps<{ apiBase: string; scope: 'app' | 'project'; projectId?: string }>()

const parentLabel = computed(() => props.scope === 'app' ? t('built-in defaults') : t('App defaults'))
const state = ref<ModelDefaultsState>()
const model = ref('')
const effort = ref<EffortChoice>('default')
const temperature = ref<string | number>('')
const inheritedEffort = computed(() => currentEffort(state.value?.inherited ?? {}))
const models = ref<string[]>([])
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const modelsError = ref('')
const notice = ref('')
let request: AbortController | undefined
const client = createModelDefaultsClient(props.apiBase, props.scope)
function accept(value: ModelDefaultsState) {
  state.value = value
  model.value = value.overrides.model ?? ''
  effort.value = currentEffort(value.overrides)
  temperature.value = value.overrides.temperature ?? ''
}
async function load() {
  request?.abort()
  const controller = request = new AbortController()
  loading.value = true
  error.value = modelsError.value = notice.value = ''
  await Promise.all([
    client.load(controller.signal).then(value => { if (!controller.signal.aborted) accept(value) })
      .catch(cause => { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load defaults.') }),
    createProjectSettingsClient(props.apiBase).models(controller.signal).then(value => { if (!controller.signal.aborted) models.value = value })
      .catch(cause => { if (!controller.signal.aborted) modelsError.value = cause instanceof Error ? cause.message : t('Could not load model choices.') }),
  ])
  if (request === controller) loading.value = false
}
async function save() {
  if (!state.value || saving.value || loading.value) return
  const controller = request = new AbortController()
  saving.value = true
  error.value = notice.value = ''
  try {
    const value = temperature.value === '' ? null : Number(temperature.value)
    if (value !== null && !Number.isFinite(value)) throw new Error(t('Enter a valid temperature or leave it empty.'))
    const result = await client.save({
      model: model.value.trim() || null, temperature: value, ...reasoningSettingsForEffort(effort.value),
    }, controller.signal)
    if (controller.signal.aborted) return
    accept(result)
    notice.value = props.scope === 'app' ? t('App defaults saved.') : t('Project defaults saved.')
    window.dispatchEvent(new CustomEvent('shadow:config-changed', { detail: { projectId: props.projectId } }))
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not save defaults. Retry.')
  } finally { if (request === controller) saving.value = false }
}
onMounted(load)
onUnmounted(() => request?.abort())
</script>

<style scoped>
h2 { margin: 0 0 16px; font-size: 20px; }
fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
.settings-field { display: grid; gap: 8px; max-width: 600px; margin: 20px 0; font-size: 13px; }
input, .ui-select { box-sizing: border-box; width: 100%; min-width: 0; padding: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
.settings-help { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; max-width: 70ch; overflow-wrap: anywhere; }
.settings-error { color: var(--c-error); font-size: 13px; overflow-wrap: anywhere; }
.settings-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 16px; }
.btn { min-height: 36px; padding: 7px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.save-defaults { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.save-defaults:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
input::placeholder { color: var(--c-text-secondary); opacity: 1; }
input:focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)), button:where(:not(.ui-select)):focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
