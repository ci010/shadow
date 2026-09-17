<template>
  <section class="provider-setup" aria-labelledby="provider-setup-title">
    <h2 id="provider-setup-title" ref="title" class="setup-title" tabindex="-1">
      <span v-if="mode === 'add'" class="i-lucide-plus" aria-hidden="true" />
      {{ mode === 'edit' ? `${providerDisplayName(status?.provider ?? '')} settings` : mode === 'add' ? 'Add provider' : 'Connect a model provider' }}
    </h2>
    <p class="lead">{{ lead }}</p>
    <p v-if="error || message" class="notice error" role="alert">{{ error || message }}</p>
    <p v-if="status?.reason && !status.ready && mode !== 'add'" class="notice">{{ providerDisplayName(status.provider) }} is not ready. {{ readinessMessage }}</p>
    <div v-if="mode !== 'edit' && !excludedProviders.includes('copilot')" class="method-tabs" aria-label="Authentication method">
      <button :aria-pressed="method === 'copilot'" :disabled="busy || saving" @click="method = 'copilot'">GitHub Copilot</button>
      <button :aria-pressed="method === 'key'" :disabled="busy || saving" @click="method = 'key'">API key / local provider</button>
    </div>

    <div v-if="method === 'copilot'" class="method-panel">
      <h2>Use your GitHub Copilot account</h2>
      <p>Authorize Shadow on GitHub using a device code. Your account must have access to Copilot.</p>
      <div v-if="login.state === 'pending' && login.login" class="device-panel" role="status" aria-live="polite">
        <span>Enter this code on GitHub</span>
        <div class="device-code"><code>{{ login.login.userCode }}</code><button @click="copyCode">{{ copied ? 'Copied' : 'Copy code' }}</button></div>
        <button class="primary" @click="openGitHub">Open github.com/login/device</button>
        <span>{{ login.login.verificationUri }}</span>
        <span>Waiting for your authorization. Code expires at {{ expiryTime }}.</span>
      </div>
      <p v-else-if="login.state !== 'idle'" role="status" aria-live="polite" class="notice" :class="{ error: failedLogin }">{{ loginMessage }}</p>
      <div class="actions">
        <button v-if="busy" :disabled="login.state === 'cancelling'" @click="cancelLogin">
          {{ login.state === 'cancelling' ? 'Cancelling...' : 'Cancel login' }}
        </button>
        <button v-else class="primary" :disabled="saving" @click="startLogin">
          {{ login.state === 'idle' ? 'Sign in with GitHub Copilot' : 'Retry GitHub Copilot login' }}
        </button>
      </div>
    </div>

    <form v-else class="method-panel" @submit.prevent="saveProvider">
      <label>Provider
        <select v-model="provider" :disabled="saving || mode === 'edit'" @change="changeProvider">
          <option v-for="preset in availablePresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
          <option value="custom">Local / OpenAI-compatible</option>
          <option v-if="!knownProviders.includes(provider)" :value="provider">{{ provider }}</option>
        </select>
      </label>
      <label v-if="provider === 'custom'">Provider name
        <input v-model="customProvider" required pattern="[a-z][a-z0-9_-]*" maxlength="64" placeholder="local" :disabled="saving || mode === 'edit'">
      </label>
      <label>Connection model <input v-model="model" required placeholder="Model ID from your provider" :disabled="saving"></label>
      <label>API base URL <input v-model="baseUrl" type="url" :required="provider === 'custom'" placeholder="Provider default, or http://127.0.0.1:11434/v1" :disabled="saving"></label>
      <label>API key <input v-model="apiKey" type="password" autocomplete="off" spellcheck="false" :disabled="saving"
        :required="provider !== 'custom' && !hasSavedKey" :placeholder="hasSavedKey ? 'Leave blank to keep the saved key' : provider === 'custom' ? 'Optional for local endpoints' : 'Enter your provider API key'"></label>
      <p class="help">Keys are saved by Main in this installation's configuration, never in browser storage. Keyless local endpoints do not require a key.</p>
      <div class="actions"><button class="primary" :disabled="saving">{{ saving ? 'Saving...' : 'Save provider connection' }}</button></div>
    </form>
    <div class="footer-actions">
      <button :disabled="busy || saving" @click="$emit('retry')">Recheck configuration</button>
      <button v-if="mode === 'edit'" :disabled="busy || saving" @click="$emit('cancel')">Done editing</button>
      <button v-else-if="canClose || status?.ready" :disabled="saving" @click="close">Back to workspace</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  COPILOT_VERIFICATION_URL, createDeviceLoginController, createProviderSetupClient,
  providerDisplayName, providerPresets,
  type LoginView, type ProviderSetupStatus,
} from './provider-setup.ts'

const props = withDefaults(defineProps<{
  apiBase: string; status: ProviderSetupStatus | null; error?: string
  mode?: 'setup' | 'add' | 'edit'; excludedProviders?: string[]; canClose?: boolean; active?: boolean
}>(), { mode: 'setup', excludedProviders: () => [], active: true })
const emit = defineEmits<{ configured: []; retry: []; close: []; cancel: []; saving: [value: boolean] }>()
const title = ref<HTMLElement | null>(null)
defineExpose({ focusTitle: () => title.value?.focus() })
const knownProviders = [...providerPresets.map(item => item.id), 'custom']
const lead = computed(() => props.mode === 'edit'
  ? 'Update this shared connection. Default models are configured separately in each project.'
  : props.excludedProviders.includes('copilot')
    ? 'Configure an API key or add a named local model endpoint.'
    : 'Sign in with GitHub Copilot, or configure an API key or local model endpoint.')
const availablePresets = computed(() => providerPresets.filter(item => props.mode !== 'add' || !props.excludedProviders.includes(item.id)))
const method = ref(props.status?.authMode === 'copilot' && props.mode !== 'add' ? 'copilot' : 'key')
const initialProvider = props.mode === 'add' ? availablePresets.value[0]?.id ?? 'custom'
  : props.status?.provider === 'copilot' ? 'openai' : props.status?.provider ?? 'openai'
const provider = ref(props.status?.authMode === 'none' || !knownProviders.includes(initialProvider) ? 'custom' : initialProvider)
const customProvider = ref(props.mode !== 'add' && provider.value === 'custom' ? initialProvider : 'local')
const model = ref(props.mode === 'add' || props.status?.authMode === 'copilot'
  ? providerPresets.find(item => item.id === initialProvider)?.model ?? ''
  : props.status?.model ?? 'gpt-4.1')
const baseUrl = ref(props.mode === 'add' || props.status?.authMode === 'copilot' ? '' : props.status?.baseUrl ?? '')
const apiKey = ref('')
const message = ref('')
const saving = ref(false)
watch(saving, value => emit('saving', value), { flush: 'sync' })
const copied = ref(false)
const login = ref<LoginView>({ state: 'idle' })
let mounted = true
const client = createProviderSetupClient(props.apiBase)
const controller = createDeviceLoginController(client, (value) => {
  if (!mounted) return
  login.value = value
  if (value.state === 'succeeded') emit('configured')
})
const busy = computed(() => ['pending', 'starting', 'cancelling'].includes(login.value.state))
const failedLogin = computed(() => ['denied', 'expired', 'error'].includes(login.value.state))
const hasSavedKey = computed(() => props.status?.provider === (provider.value === 'custom' ? customProvider.value : provider.value) && props.status.hasApiKey)
const readinessMessages: Record<string, string> = {
  missing_credentials: 'Add credentials or choose another provider.',
  invalid_credentials: 'Credentials were rejected. Update them or sign in again.',
  network_error: 'Check the connection, then recheck configuration.',
}
const readinessMessage = computed(() => readinessMessages[props.status?.reason ?? ''] ?? 'Complete the configuration below.')
const expiryTime = computed(() => new Date(login.value.login?.expiresAt ?? 0).toLocaleTimeString())
const loginMessage = computed(() => login.value.error ?? ({
  idle: '', starting: 'Requesting a GitHub device code...', pending: 'Waiting for authorization...',
  cancelling: 'Cancelling login...', cancelled: 'Login cancelled. You can try again.',
  denied: 'Authorization was declined. Start a new login when ready.',
  expired: 'The device code expired. Start a new login to get another code.',
  succeeded: 'Copilot is connected. Opening your workspace...',
  error: 'GitHub login failed. Check your network and Copilot access, then retry.',
}[login.value.state]))

function changeProvider() {
  model.value = providerPresets.find(item => item.id === provider.value)?.model ?? ''
  baseUrl.value = ''
  apiKey.value = ''
  message.value = ''
}
async function saveProvider() {
  const name = provider.value === 'custom' ? customProvider.value.trim() : provider.value
  if (props.mode === 'add' && props.excludedProviders.includes(name)) {
    message.value = 'This provider is already configured. Use its card above to update it, or choose a different name.'
    return
  }
  saving.value = true
  message.value = ''
  try {
    const result = await client.save({
      provider: name,
      model: model.value.trim(),
      ...(apiKey.value ? { apiKey: apiKey.value } : {}),
      baseUrl: baseUrl.value.trim(),
    })
    apiKey.value = ''
    if (result.ready) emit('configured')
    else {
      message.value = `Configuration was not saved. ${readinessMessages[result.reason ?? ''] ?? 'Check credentials and connectivity, then retry.'}`
    }
  } catch (error) {
    message.value = error instanceof Error ? error.message : 'Could not save the provider. Please retry.'
  } finally {
    saving.value = false
    apiKey.value = ''
  }
}
function startLogin() { message.value = ''; copied.value = false; void controller.start() }
async function cancelLogin() { await controller.cancel() }
async function close() { await controller.cancel(); emit('close') }
async function copyCode() {
  try {
    await navigator.clipboard.writeText(login.value.login?.userCode ?? '')
    copied.value = true
  } catch { message.value = 'Clipboard is unavailable. Select and copy the displayed device code manually.' }
}
async function openGitHub() {
  try {
    if (window.shadowDesktop) {
      if (!window.shadowDesktop.openCopilotLogin) throw new Error('Restart Desktop to enable secure login links.')
      await window.shadowDesktop.openCopilotLogin()
    } else {
      window.open(COPILOT_VERIFICATION_URL, '_blank', 'noopener,noreferrer')
    }
  } catch { message.value = 'Could not open the browser. Open https://github.com/login/device manually.' }
}
const leave = () => { void controller.cancel() }
watch(() => props.active, active => { if (!active) leave() })
window.addEventListener('beforeunload', leave)
onBeforeUnmount(() => {
  mounted = false
  apiKey.value = ''
  window.removeEventListener('beforeunload', leave)
  void controller.cancel()
})
</script>

<style scoped>
.provider-setup { max-width: 680px; min-width: 0; margin: 24px auto; padding: 30px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); }
.setup-title { display: flex; align-items: center; gap: 10px; margin: 0 0 12px; font-size: 20px; overflow-wrap: anywhere; }
.setup-title span { width: 20px; height: 20px; flex-shrink: 0; }
h2 { font-size: 17px; }
.lead, .method-panel p { color: var(--c-text-secondary); line-height: 1.6; }
.lead { margin: 0 0 24px; max-width: 70ch; }
.method-tabs, .actions, .footer-actions, .device-code { display: flex; flex-wrap: wrap; gap: 10px; }
.method-tabs { margin: 22px 0; }.method-tabs [aria-pressed="true"] { border-color: var(--c-success); color: var(--c-success); }
button { padding: 9px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-soft); font: inherit; cursor: pointer; }
button:disabled { opacity: .55; cursor: not-allowed; } button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--c-success); outline-offset: 2px; }
.primary { background: #147a57; border-color: #147a57; color: white; }.actions { justify-content: flex-end; margin-top: 20px; }
.method-panel { display: grid; gap: 12px; } label { display: grid; gap: 6px; font-size: 13px; }
input, select { min-width: 0; padding: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text); font: inherit; }
.help { font-size: 12px; }.notice { padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); line-height: 1.5; }.error { border-color: var(--c-error); color: var(--c-error); }
.device-panel { display: grid; gap: 14px; padding: 20px; background: var(--c-bg-soft); border: 1px solid var(--c-border); border-radius: var(--radius-surface); }.device-panel span { font-size: 13px; color: var(--c-text-secondary); }
.device-code { align-items: center; justify-content: space-between; }.device-code code { user-select: text; font: 700 26px monospace; letter-spacing: .08em; }
.footer-actions { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--c-border); justify-content: space-between; }
@media (max-width: 680px) { .provider-setup { padding: 20px; margin: 12px auto; } }
</style>
