<template>
  <div ref="view" class="providers-view" :class="{ embedded }">
    <p v-if="!available" role="status">{{ t('Provider settings are managed by Main administrators.') }}</p>
    <p v-else-if="checking" role="status">{{ t('Checking model provider configuration...') }}</p>
    <template v-else>
      <header class="providers-heading">
        <div>
          <component :is="embedded ? 'h2' : 'h1'" class="providers-title">{{ t('Providers') }}</component>
          <p>{{ t('Manage your configured providers and add new connections.') }}</p>
        </div>
      </header>
      <p v-if="loading" role="status">{{ t('Loading configured providers...') }}</p>
      <div v-else-if="inventoryError" class="inventory-error" role="alert">
        <p>{{ inventoryError }}</p>
        <button @click="loadProviders">{{ t('Retry provider list') }}</button>
      </div>
      <template v-else>
        <div v-if="providers.length" class="provider-cards" :aria-label="t('Configured providers')">
          <article v-for="item in providers" :key="item.provider" class="provider-card" :data-provider="item.provider">
            <div class="provider-card-heading">
              <span :class="item.authMode === 'copilot' ? 'i-lucide-github' : item.authMode === 'none' ? 'i-lucide-server' : 'i-lucide-key-round'" class="provider-icon" aria-hidden="true" />
              <h2>{{ providerDisplayName(item.provider) }}</h2>
              <span v-if="item.selected" class="provider-selected">{{ t('Selected') }}</span>
            </div>
            <p class="provider-auth">{{ authLabels[item.authMode] }}</p>
            <p v-if="item.baseUrl" class="provider-endpoint" :title="item.baseUrl">{{ item.baseUrl }}</p>
            <p v-else class="provider-endpoint">{{ item.authMode === 'copilot' ? t('GitHub account') : t('Provider endpoint') }}</p>
            <div class="provider-card-footer">
              <span class="provider-state" :class="{ 'needs-attention': item.selected && !status?.ready }">
                {{ item.selected ? status?.ready ? t('Ready') : t('Needs attention') : t('Configured') }}
              </span>
              <button :aria-label="t('Configure {value1}', { value1: providerDisplayName(item.provider) })" :aria-pressed="editing === item.provider" :disabled="saving" @click="editProvider(item.provider)">
                <span class="i-lucide-settings-2" aria-hidden="true" /> {{ t('Configure') }}
              </button>
            </div>
          </article>
        </div>
        <ProviderSetup
          :key="apiBase + ':' + (editing ?? formMode) + ':' + providers.map(item => item.provider).join(',')"
          ref="setup"
          class="provider-form"
          :api-base="apiBase"
          :active="active !== false"
          :status="formStatus"
          :error="error"
          :mode="formMode"
          :excluded-providers="formMode === 'add' ? providers.map(item => item.provider) : []"
          :can-close="status?.ready"
          @configured="$emit('configured')"
          @retry="$emit('retry')"
          @close="$emit('close')"
          @cancel="finishEditing"
          @saving="saving = $event"
        />
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import ProviderSetup from '../ProviderSetup.vue'
import {
  createProviderSetupClient, providerDisplayName, providerPresets,
  type ConfiguredProvider, type ProviderSetupStatus,
} from '../provider-setup.ts'

const props = defineProps<{
  apiBase: string
  status: ProviderSetupStatus | null
  error: string
  checking: boolean
  available: boolean
  embedded?: boolean
  active?: boolean
}>()
defineEmits<{ configured: []; retry: []; close: [] }>()

const providers = ref<ConfiguredProvider[]>([])
const loading = ref(true)
const inventoryError = ref('')
const editing = ref<string | null>(null)
const saving = ref(false)
const view = ref<HTMLElement | null>(null)
const setup = ref<InstanceType<typeof ProviderSetup> | null>(null)
const authLabels = { get 'api-key'() { return t('API key') }, get copilot() { return t('Device sign-in') }, get none() { return t('Keyless endpoint') } }
const formMode = computed(() => editing.value ? 'edit' : props.status?.ready || providers.value.length ? 'add' : 'setup')
const formStatus = computed<ProviderSetupStatus | null>(() => {
  const item = providers.value.find(item => item.provider === editing.value)
  if (!item) return formMode.value === 'setup' ? props.status : null
  if (item.selected && props.status?.provider === item.provider) return props.status
  return {
    provider: item.provider, authMode: item.authMode, hasApiKey: item.hasApiKey,
    baseUrl: item.baseUrl, ready: false,
    model: item.model ?? providerPresets.find(preset => preset.id === item.provider)?.model ?? '',
  }
})
let request: AbortController | undefined
async function loadProviders() {
  request?.abort()
  if (!props.available || props.checking || props.active === false) return
  const controller = new AbortController()
  request = controller
  if (!providers.value.length) loading.value = true
  inventoryError.value = ''
  try {
    const result = await createProviderSetupClient(props.apiBase).configured(controller.signal)
    if (controller.signal.aborted) return
    providers.value = result
    if (!result.some(item => item.provider === editing.value)) editing.value = null
  } catch (error) {
    if (!controller.signal.aborted) {
      inventoryError.value = error instanceof Error ? error.message : t('Could not load providers. Retry when Main is available.')
    }
  } finally {
    if (!controller.signal.aborted) loading.value = false
  }
}
async function editProvider(provider: string) {
  editing.value = provider
  await nextTick()
  setup.value?.focusTitle()
}
async function finishEditing() {
  const provider = editing.value
  editing.value = null
  await nextTick()
  const cards = view.value?.querySelectorAll<HTMLElement>('.provider-card')
  Array.from(cards ?? []).find(card => card.dataset.provider === provider)?.querySelector('button')?.focus()
}
watch(() => [props.apiBase, props.available, props.checking, props.status, props.active], loadProviders, { immediate: true })
onBeforeUnmount(() => request?.abort())
</script>

<style scoped>
.providers-view { width: 100%; max-width: 1040px; min-width: 0; box-sizing: border-box; margin: 0 auto; padding: 28px 24px 40px; color: var(--c-text); }
.providers-heading { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 20px; margin-bottom: 28px; }
.providers-title { margin: 0 0 8px; font-size: 24px; }
.providers-view.embedded { max-width: none; padding: 0; }
.embedded .providers-title { font-size: 20px; }
.providers-heading p { margin: 0; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
.settings-model-selector { display: grid; justify-items: start; gap: 6px; min-width: 0; }
.settings-model-selector > span { font-size: 12px; color: var(--c-text-secondary); }
.provider-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 16px; margin-bottom: 24px; }
.provider-card { display: flex; flex-direction: column; min-width: 0; padding: 20px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); }
.provider-card-heading { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; }
.provider-icon { width: 20px; height: 20px; flex-shrink: 0; }
.provider-card h2 { flex: 1; margin: 0; min-width: 100px; font-size: 16px; line-height: 1.4; overflow-wrap: anywhere; }
.provider-selected { color: var(--c-blue); font-size: 12px; }
.provider-auth { margin: 16px 0 6px; font-size: 13px; color: var(--c-text-secondary); }
.provider-endpoint { margin: 0 0 24px; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.provider-card-footer { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 12px; margin-top: auto; }
.provider-state { font-size: 12px; color: var(--c-text-secondary); }
.needs-attention, .inventory-error { color: var(--c-error); }
button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 36px; padding: 8px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-soft); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
button span { width: 14px; height: 14px; }
button:hover, button[aria-pressed="true"] { background: var(--c-bg-muted); }
button:disabled { opacity: .55; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.provider-form { max-width: none; margin: 0; }
@media (max-width: 680px) {
  .providers-view { padding: 20px 16px 28px; }
  .providers-heading { margin-bottom: 24px; }
  .provider-card { padding: 16px; }
  button { min-height: 44px; }
}
</style>
