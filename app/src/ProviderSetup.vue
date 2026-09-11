<template>
  <section class="provider-setup" aria-labelledby="provider-setup-title">
    <p class="eyebrow">MODEL ACCESS</p>
    <h1 id="provider-setup-title">{{ status?.ready ? 'Provider settings' : 'Connect a model provider' }}</h1>
    <p class="lead">Sign in with GitHub Copilot, or configure an API key or local model endpoint before starting a chat.</p>
    <p v-if="error || message" class="notice error" role="alert">{{ error || message }}</p>
    <p v-if="status && !status.ready" class="notice">{{ status.provider }} is not ready. {{ readinessMessage }}</p>
    <div class="method-tabs" aria-label="Authentication method">
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
        <select v-model="provider" :disabled="saving" @change="changeProvider">
          <option value="openai">OpenAI</option><option value="anthropic">Anthropic</option>
          <option value="deepseek">DeepSeek</option><option value="openrouter">OpenRouter</option>
          <option value="gemini">Google Gemini</option><option value="groq">Groq</option>
          <option value="custom">Local / OpenAI-compatible</option>
          <option v-if="!knownProviders.includes(provider)" :value="provider">{{ provider }}</option>
        </select>
      </label>
      <label v-if="provider === 'custom'">Provider name
        <input v-model="customProvider" required pattern="[a-z][a-z0-9_-]*" placeholder="local">
      </label>
      <label>Model <input v-model="model" required placeholder="Model ID from your provider" :disabled="saving"></label>
      <label>API base URL <input v-model="baseUrl" type="url" :required="provider === 'custom'" placeholder="Provider default, or http://127.0.0.1:11434/v1" :disabled="saving"></label>
      <label>API key <input v-model="apiKey" type="password" autocomplete="off" spellcheck="false" :disabled="saving"
        :required="provider !== 'custom' && !hasSavedKey" :placeholder="hasSavedKey ? 'Leave blank to keep the saved key' : provider === 'custom' ? 'Optional for local endpoints' : 'Enter your provider API key'"></label>
      <p class="help">Keys are saved by Main in this installation's configuration, never in browser storage. Keyless local endpoints do not require a key.</p>
      <div class="actions"><button class="primary" :disabled="saving">{{ saving ? 'Saving...' : 'Save provider and continue' }}</button></div>
    </form>
    <div class="footer-actions">
      <button :disabled="busy || saving" @click="$emit('retry')">Recheck configuration</button>
      <button v-if="status?.ready" :disabled="saving" @click="close">Back to workspace</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import {
  COPILOT_VERIFICATION_URL, createDeviceLoginController, createProviderSetupClient,
  type LoginView, type ProviderSetupStatus,
} from './provider-setup.ts'

const props = defineProps<{ apiBase: string; status: ProviderSetupStatus | null; error?: string }>()
const emit = defineEmits<{ configured: []; retry: []; close: [] }>()
const knownProviders = ['openai', 'anthropic', 'deepseek', 'openrouter', 'gemini', 'groq', 'custom']
const method = ref(props.status?.authMode === 'copilot' ? 'copilot' : 'key')
const initialProvider = props.status?.provider === 'copilot' ? 'openai' : props.status?.provider ?? 'openai'
const provider = ref(props.status?.authMode === 'none' || !knownProviders.includes(initialProvider) ? 'custom' : initialProvider)
const customProvider = ref(provider.value === 'custom' ? initialProvider : 'local')
const model = ref(props.status?.authMode === 'copilot' ? 'gpt-4.1' : props.status?.model ?? 'gpt-4.1')
const baseUrl = ref(props.status?.authMode === 'copilot' ? '' : props.status?.baseUrl ?? '')
const apiKey = ref('')
const message = ref('')
const saving = ref(false)
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
  const defaults: Record<string, string> = {
    openai: 'gpt-4.1', anthropic: 'claude-sonnet-4-6', deepseek: 'deepseek-chat',
    openrouter: 'anthropic/claude-sonnet-4.6', gemini: 'gemini-2.5-pro', groq: 'llama-3.3-70b-versatile',
  }
  model.value = defaults[provider.value] ?? ''
  baseUrl.value = ''
  apiKey.value = ''
  message.value = ''
}
async function saveProvider() {
  saving.value = true
  message.value = ''
  try {
    const result = await client.save({
      provider: provider.value === 'custom' ? customProvider.value.trim() : provider.value,
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
window.addEventListener('beforeunload', leave)
onBeforeUnmount(() => {
  mounted = false
  apiKey.value = ''
  window.removeEventListener('beforeunload', leave)
  void controller.cancel()
})
</script>

<style scoped>
.provider-setup { max-width: 680px; margin: 24px auto; padding: 30px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); }
.eyebrow { color: var(--c-success); font-size: 11px; font-weight: 700; letter-spacing: .1em; }
h1 { font-size: 24px; margin: 8px 0 14px; } h2 { font-size: 17px; }
.lead, .method-panel p { color: var(--c-text-secondary); line-height: 1.6; }
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
