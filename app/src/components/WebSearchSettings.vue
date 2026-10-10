<template>
  <form class="web-search-settings" @submit.prevent="save" @input="notice = ''" @change="notice = ''">
    <h2>{{ t('Web search') }}</h2>
    <p class="settings-help">{{ t('Search service and API keys are shared by all Projects. Saved changes apply to subsequent searches; running requests are unchanged.') }}</p>
    <p v-if="loading" role="status">{{ t('Loading web search settings...') }}</p>
    <p v-if="error" class="settings-error" role="alert">
      {{ error }}
      <button type="button" class="btn" :disabled="loading || saving" @click="load">{{ t('Reload settings') }}</button>
    </p>
    <fieldset :disabled="loading || saving || !state">
      <label class="settings-field" :for="`${id}-provider`">{{ t('Search service') }}
        <UiSelect :id="`${id}-provider`" v-model="provider" :aria-describedby="`${id}-selection-help`">
          <option value="auto">{{ t('Automatic') }}</option>
          <option v-for="item in searchProviders" :key="item.id" :value="item.id">{{ item.label }}</option>
        </UiSelect>
      </label>
      <p :id="`${id}-selection-help`" class="settings-help">
        {{ t('Automatic uses the first configured key: Firecrawl, Brave, Exa, then Tavily. Without keys, it uses keyless Firecrawl. Failed searches never switch services automatically.') }}
      </p>
      <h3>{{ t('API keys') }}</h3>
      <p class="settings-help">{{ t('Saved keys are never shown. Leave a field blank to keep its key, or select Remove key. Environment variables override saved keys when Main restarts.') }}</p>
      <div v-for="item in searchProviders" :key="item.id" class="key-row">
        <div class="key-heading">
          <label :for="`${id}-${item.id}`">{{ item.label }} {{ t('API key') }}</label>
          <span :id="`${id}-${item.id}-status`" class="key-status">{{ state?.keys[item.id] ? t('Configured') : t('Not configured') }}</span>
        </div>
        <input :id="`${id}-${item.id}`" v-model="keys[item.id].value" type="password" autocomplete="new-password"
          :disabled="keys[item.id].remove" :maxlength="4096" :spellcheck="false" autocapitalize="none"
          :aria-describedby="`${id}-${item.id}-status`"
          :placeholder="state?.keys[item.id] ? t('Enter a replacement key') : t('Enter an API key')" />
        <label v-if="state?.keys[item.id]" class="remove-key">
          <input v-model="keys[item.id].remove" type="checkbox" /> {{ t('Remove') }} {{ item.label }} {{ t('key on save') }}
        </label>
        <p v-if="item.id === 'firecrawl'" class="key-help">{{ t('Optional: keyless access is subject to Firecrawl availability and limits.') }}</p>
      </div>
      <div class="settings-actions">
        <button class="btn save-settings" type="submit" :disabled="!dirty">{{ saving ? t('Saving...') : t('Save web search settings') }}</button>
      </div>
    </fieldset>
    <p v-if="state" class="settings-help" role="status">
      {{ t('Saved service:') }} {{ searchProviderLabel(state.effectiveProvider) }}{{ state.provider === 'auto' ? t(' (automatic)') : '' }}.
      <template v-if="!state.ready">{{ t('Add its API key or choose another service to enable searches.') }}</template>
      <template v-else-if="state.effectiveProvider === 'firecrawl' && !state.keys.firecrawl">{{ t('Using keyless access.') }}</template>
    </p>
    <p v-if="notice" class="settings-help" role="status">{{ notice }}</p>
  </form>
</template>

<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { t } from '../i18n.ts'
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import {
  createWebSearchSettingsClient, emptySearchKeys, searchProviderLabel, searchProviders, webSearchPatch,
  type WebSearchSelection, type WebSearchStatus,
} from '../web-search-settings.ts'

const props = defineProps<{ apiBase: string }>()
const id = useId()
const state = ref<WebSearchStatus>()
const provider = ref<WebSearchSelection>('auto')
const keys = ref(emptySearchKeys())
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
let request: AbortController | undefined
const patch = computed(() => state.value ? webSearchPatch(state.value, provider.value, keys.value) : {})
const dirty = computed(() => Object.keys(patch.value).length > 0)

function accept(value: WebSearchStatus) {
  state.value = value
  provider.value = value.provider
  keys.value = emptySearchKeys()
}
async function load() {
  request?.abort()
  const controller = request = new AbortController()
  loading.value = true
  saving.value = false
  state.value = undefined
  keys.value = emptySearchKeys()
  error.value = notice.value = ''
  try {
    const value = await createWebSearchSettingsClient(props.apiBase).load(controller.signal)
    if (!controller.signal.aborted) accept(value)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load web search settings.')
  } finally { if (request === controller) loading.value = false }
}
async function save() {
  if (!state.value || loading.value || saving.value || !dirty.value) return
  const controller = request = new AbortController()
  saving.value = true
  error.value = notice.value = ''
  try {
    const value = await createWebSearchSettingsClient(props.apiBase).save(patch.value, controller.signal)
    if (controller.signal.aborted) return
    accept(value)
    notice.value = t('Web search settings saved for all Projects.')
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not save web search settings. Retry.')
  } finally { if (request === controller) saving.value = false }
}
watch(() => props.apiBase, load, { immediate: true })
onUnmounted(() => { request?.abort(); keys.value = emptySearchKeys() })
</script>

<style scoped>
.web-search-settings { max-width: 720px; }
h2 { margin: 0 0 16px; font-size: 20px; }
h3 { margin: 32px 0 8px; font-size: 16px; }
fieldset { padding: 0; margin: 0; border: 0; min-width: 0; }
.settings-field { display: grid; gap: 8px; margin: 20px 0 8px; font-size: 13px; max-width: 600px; }
.settings-help { margin: 8px 0 16px; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; max-width: 70ch; overflow-wrap: anywhere; }
.settings-error { color: var(--c-error); font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.key-row { max-width: 600px; padding: 20px 0; border-bottom: 1px solid var(--c-border); }
.key-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; font-size: 13px; }
.key-status, .key-help { color: var(--c-text-secondary); font-size: 12px; }
.key-help { margin: 8px 0 0; line-height: 1.6; }
input[type="password"], .ui-select { box-sizing: border-box; width: 100%; min-width: 0; min-height: 44px; padding: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 14px; }
input::placeholder { color: var(--c-text-secondary); opacity: 1; }
.remove-key { display: flex; align-items: center; gap: 8px; min-height: 44px; color: var(--c-text-secondary); font-size: 13px; cursor: pointer; }
.remove-key input { margin: 0; width: 16px; height: 16px; accent-color: var(--c-primary-bg); }
.settings-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 24px 0 16px; }
.btn { min-height: 44px; padding: 8px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.save-settings { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.save-settings:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
input:focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)), button:where(:not(.ui-select)):focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
