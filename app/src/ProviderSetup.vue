<template>
  <section class="provider-setup" aria-labelledby="provider-setup-title">
    <h2 id="provider-setup-title" ref="title" class="setup-title" tabindex="-1">
      <span v-if="mode === 'add'" class="i-lucide-plus" aria-hidden="true" />
      {{ mode === 'edit' ? t('{value1} settings', { value1: editingLabel }) : mode === 'add' ? t('Add provider') : t('Connect a model provider') }}
    </h2>
    <p class="lead">{{ lead }}</p>
    <label>{{ t('Display name') }} <input v-model="displayName" maxlength="100" :disabled="busy || saving"></label>
    <p v-if="mode === 'edit'" class="help">{{ status?.provider }}</p>
    <button v-if="mode === 'edit'" :disabled="busy || saving || !displayName.trim()" @click="renameInstance">{{ t('Rename') }}</button>
    <p v-if="error || message" class="notice error" role="alert">{{ error || message }}</p>
    <p v-if="signedOut" class="notice" role="status">{{ t('Signed out of Copilot instance {account} on {host}. Other instances, including accounts on the same host, and sign-ins on other hosts are unchanged.', { account: accountLabel, host: status?.host ?? 'github.com' }) }}</p>
    <p v-else-if="status?.reason && !status.ready && mode !== 'add' && !busy && !failedLogin && login.state !== 'succeeded'" class="notice error" role="alert">{{ providerDisplayName(status.provider) }} {{ t('is not ready.') }} {{ readinessMessage }}</p>
    <div v-if="mode !== 'edit' && !excludedProviders.includes('copilot')" class="method-tabs" :aria-label="t('Authentication method')">
      <button :aria-pressed="method === 'copilot'" :disabled="busy || saving" @click="method = 'copilot'">GitHub Copilot</button>
      <button :aria-pressed="method === 'key'" :disabled="busy || saving" @click="method = 'key'">{{ t('API key / local provider') }}</button>
    </div>

    <div v-if="method === 'copilot'" class="method-panel">
      <h2>{{ t('Use your GitHub Copilot account') }} <small>v2</small></h2>
      <p>{{ t('Authorize Shadow on GitHub using a device code. Your account must have access to Copilot.') }}</p>
      <p class="help">{{ t('This v2 sign-in uses the GitHub Copilot App OAuth client with only the copilot scope. Broader repository and workflow permissions are not requested. The authorization page may identify the official app rather than Shadow.') }}</p>
      <p v-if="mode === 'edit' && status?.authMode === 'copilot'" class="help">{{ t('Current Copilot host: {host}', { host: status.host ?? 'github.com' }) }}</p>
      <label>{{ t('GitHub account host') }}
        <UiSelect v-model="copilotHostType" :disabled="busy || saving">
          <option value="github">GitHub.com</option>
          <option value="enterprise">{{ t('GitHub Enterprise Cloud (*.ghe.com)') }}</option>
        </UiSelect>
      </label>
      <label v-if="copilotHostType === 'enterprise'">{{ t('Enterprise subdomain prefix') }}
        <span class="enterprise-host-field"><input v-model="enterpriseHost" placeholder="octocat" maxlength="63" aria-describedby="enterprise-host-suffix" autocomplete="off" autocapitalize="none" spellcheck="false" :disabled="busy || saving" :aria-invalid="!!hostError"><span id="enterprise-host-suffix" class="enterprise-host-suffix">.ghe.com</span></span>
        <span v-if="hostError" class="help error">{{ hostError }}</span>
        <span v-else class="help">{{ t('Enter only your enterprise subdomain, for example octocat. The .ghe.com suffix is added automatically.') }}</span>
      </label>
      <div v-if="login.state === 'pending' && login.login" class="device-panel" role="status" aria-live="polite">
        <span>{{ t('Enter this code on GitHub') }}</span>
        <div class="device-code"><code>{{ login.login.userCode }}</code><button @click="copyCode">{{ copied ? t('Copied') : t('Copy code') }}</button></div>
        <button class="primary" @click="openGitHub">{{ t('Open {host}/login/device', { host: login.login.host ?? 'github.com' }) }}</button>
        <span>{{ login.login.verificationUri }}</span>
        <span>{{ t('Waiting for your authorization. Code expires at') }} {{ expiryTime }}.</span>
      </div>
      <p v-else-if="login.state !== 'idle'" :role="failedLogin ? 'alert' : 'status'" aria-live="polite" class="notice" :class="{ error: failedLogin }">{{ loginMessage }}</p>
      <div class="actions">
        <button v-if="busy" :disabled="login.state === 'cancelling'" @click="cancelLogin">
          {{ login.state === 'cancelling' ? t('Cancelling...') : t('Cancel login') }}
        </button>
        <button v-else class="primary" :disabled="saving || !!hostError" @click="startLogin">
          {{ login.state === 'idle' ? t('Sign in with GitHub Copilot') : t('Retry GitHub Copilot login') }}
        </button>
        <button v-if="mode === 'edit' && !confirmSignOut && !signedOut" :disabled="saving" @click="confirmSignOut = true">{{ t('Sign out of GitHub Copilot') }}</button>
      </div>
      <div v-if="confirmSignOut" class="notice" role="group" :aria-label="t('Confirm Copilot sign-out')">
        <p>{{ t('Remove provider {account} and its saved Copilot sign-in on {host}? This affects all projects using this instance. Other instances, including accounts on the same host, and sign-ins on other hosts are unchanged. It does not sign you out in your browser or revoke the GitHub authorization.', { account: accountLabel, host: status?.host ?? 'github.com' }) }}</p>
        <div class="actions">
          <button :disabled="saving" @click="confirmSignOut = false">{{ t('Cancel') }}</button>
          <button :disabled="saving" @click="signOut">{{ saving ? t('Signing out...') : t('Sign out of GitHub Copilot') }}</button>
        </div>
      </div>
    </div>

    <form v-else class="method-panel" @submit.prevent="saveProvider">
      <label>{{ t('Provider') }}
        <UiSelect v-model="provider" :disabled="saving || mode === 'edit'" @change="changeProvider">
          <option v-for="preset in availablePresets" :key="preset.id" :value="preset.id">{{ preset.name }}</option>
          <option value="custom">{{ t('Local / OpenAI-compatible') }}</option>
          <option v-if="!knownProviders.includes(provider)" :value="provider">{{ provider }}</option>
        </UiSelect>
      </label>
      <label v-if="provider === 'custom'">{{ t('Provider name') }}
        <input v-model="customProvider" required pattern="[a-z][a-z0-9_-]*" maxlength="64" placeholder="local" :disabled="saving || mode === 'edit'">
      </label>
      <label>{{ t('Connection model') }} <input v-model="model" required :placeholder="t('Model ID from your provider')" :disabled="saving"></label>
      <label v-if="provider === 'custom'">{{ t('API base URL') }} <input v-model="baseUrl" type="url" :required="provider === 'custom'" :placeholder="t('Provider default, or http://127.0.0.1:11434/v1')" :disabled="saving"></label>
      <label>{{ t('API key') }} <input v-model="apiKey" type="password" autocomplete="off" spellcheck="false" :disabled="saving"
        :required="provider !== 'custom' && !hasSavedKey" :placeholder="hasSavedKey ? t('Leave blank to keep the saved key') : provider === 'custom' ? t('Optional for local endpoints') : t('Enter your provider API key')"></label>
      <p class="help">{{ t('Keys are saved by Main in this installation\'s configuration, never in browser storage. Keyless local endpoints do not require a key.') }}</p>
      <div class="actions"><button class="primary" :disabled="saving">{{ saving ? t('Saving...') : t('Save provider connection') }}</button></div>
    </form>
    <div class="footer-actions">
      <button :disabled="busy || saving" @click="$emit('retry')">{{ t('Recheck configuration') }}</button>
      <button v-if="mode === 'edit'" :disabled="busy || saving" @click="$emit('cancel')">{{ t('Done editing') }}</button>
      <button v-else-if="canClose || status?.ready" :disabled="saving" @click="close">{{ t('Back to workspace') }}</button>
    </div>
  </section>
</template>

<script setup lang="ts">
import { enterprisePrefix, enterpriseHostFromPrefix } from './copilot-host-input.ts'
import { createUuid } from './uuid.ts'
import UiSelect from './components/UiSelect.vue'
import { t, formatDateTime } from './i18n.ts'
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  normalizeCopilotHost, createDeviceLoginController, createProviderSetupClient,
  providerDisplayName, providerPresets,
  copilotFailureMessage,
  providerFailureMessage,
  type LoginView, type ProviderSetupStatus,
} from './provider-setup.ts'

const props = withDefaults(defineProps<{
  apiBase: string; status: ProviderSetupStatus | null; error?: string
  mode?: 'setup' | 'add' | 'edit'; excludedProviders?: string[]; canClose?: boolean; active?: boolean
}>(), { mode: 'setup', excludedProviders: () => [], active: true })
const emit = defineEmits<{ configured: []; retry: []; close: []; cancel: []; saving: [value: boolean] }>()
const title = ref<HTMLElement | null>(null)
const editingLabel = computed(() => props.status?.name
  ? `${props.status.name} · ${providerDisplayName(props.status.type ?? props.status.provider)}`
  : providerDisplayName(props.status?.type ?? props.status?.provider ?? ''))
const accountLabel = computed(() => `${editingLabel.value} (${props.status?.provider ?? instanceId.value})`)
defineExpose({ focusTitle: () => title.value?.focus() })
const knownProviders = [...providerPresets.map(item => item.id), 'custom']
const lead = computed(() => props.mode === 'edit'
  ? t('Update this shared connection. Default models are configured separately in each project.')
  : props.excludedProviders.includes('copilot')
    ? t('Configure an API key or add a named local model endpoint.')
    : t('Sign in with GitHub Copilot, or configure an API key or local model endpoint.'))
const availablePresets = computed(() => providerPresets)
const method = ref(props.status?.authMode === 'copilot' && props.mode !== 'add' ? 'copilot' : 'key')
const initialProvider = props.mode === 'add' ? availablePresets.value[0]?.id ?? 'custom'
  : props.status?.authMode === 'copilot' ? 'openai' : props.status?.type ?? props.status?.provider ?? 'openai'
const provider = ref(props.status?.authMode === 'none' || !knownProviders.includes(initialProvider) ? 'custom' : initialProvider)
const customProvider = ref(props.mode !== 'add' && provider.value === 'custom' ? initialProvider : 'local')
const model = ref(props.mode === 'add' || props.status?.authMode === 'copilot'
  ? providerPresets.find(item => item.id === initialProvider)?.model ?? ''
  : props.status?.model ?? 'gpt-4.1')
const baseUrl = ref(props.mode === 'add' || props.status?.authMode === 'copilot' ? '' : props.status?.baseUrl ?? '')
const initialCopilotHost = props.mode !== 'add' && props.status?.authMode === 'copilot' ? props.status.host ?? 'github.com' : 'github.com'
const copilotHostType = ref(initialCopilotHost === 'github.com' ? 'github' : 'enterprise')
const enterpriseHost = ref(enterprisePrefix(initialCopilotHost))
const selectedCopilotHost = computed(() => {
  if (copilotHostType.value === 'github') return 'github.com'
  try { return enterpriseHostFromPrefix(enterpriseHost.value) } catch { return '' }
})
const hostError = computed(() => {
  try {
    const host = normalizeCopilotHost(selectedCopilotHost.value)
    if (copilotHostType.value === 'enterprise' && host === 'github.com') throw new Error('Enterprise hostname required')
    return ''
  } catch { return t('Enter only a valid enterprise subdomain prefix, such as octocat, without .ghe.com, a URL, port or path.') }
})
const newId = `account-${createUuid()}`
const instanceId = computed(() => {
  if (props.mode === 'edit') return props.status!.provider
  if (props.mode === 'add') return method.value === 'copilot' ? `${newId}-copilot` : newId
  if (method.value === 'copilot') return 'copilot'
  return provider.value === 'custom' ? customProvider.value.trim() : provider.value
})
const displayName = ref(props.mode !== 'add' ? props.status?.name ?? '' : '')
const apiKey = ref('')
const message = ref('')
const saving = ref(false)
watch(saving, value => emit('saving', value), { flush: 'sync' })
const copied = ref(false)
const confirmSignOut = ref(false)
const signedOut = ref(false)
const login = ref<LoginView>({ state: 'idle' })
let mounted = true
const client = createProviderSetupClient(props.apiBase, fetch, () => instanceId.value)
const controller = createDeviceLoginController(client, (value) => {
  if (!mounted) return
  login.value = value
  if (value.state === 'succeeded') emit('configured')
})
const busy = computed(() => ['pending', 'starting', 'cancelling'].includes(login.value.state))
const failedLogin = computed(() => ['denied', 'expired', 'error'].includes(login.value.state))
const hasSavedKey = computed(() => props.status?.provider === instanceId.value && props.status.hasApiKey)
const readinessMessages: Record<string, string> = {
  get retired_copilot() { return t('This Copilot authentication version is no longer supported. Select another connection to continue. To reuse this connection ID, stop Main and change its configured type to copilot or copilot-v2, then sign in if needed. Saved credentials have not been changed.') },
  get missing_credentials() { return t('Add credentials or choose another provider.') },
  get invalid_credentials() { return t('Credentials were rejected. Update them or sign in again.') },
  get permission_denied() { return t('The provider denied access. Check your API key and account permissions.') },
  get network_error() { return providerFailureMessage('network') },
  get proxy_error() { return copilotFailureMessage('proxy') },
  get storage_error() { return copilotFailureMessage('storage') },
  get scope_missing_error() { return copilotFailureMessage('scope_missing') },
}
const readinessMessage = computed(() => readinessMessages[props.status?.reason ?? ''] ?? t('Complete the configuration below.'))
const expiryTime = computed(() => formatDateTime(new Date(login.value.login?.expiresAt ?? 0), { hour: 'numeric', minute: '2-digit', second: '2-digit' }))
const loginMessage = computed(() => login.value.error ?? ({
  idle: '', starting: t('Requesting a GitHub device code...'), pending: t('Waiting for authorization...'),
  cancelling: t('Cancelling login...'), cancelled: t('Login cancelled. You can try again.'),
  denied: 'Authorization was declined. Start a new login when ready.',
  expired: t('The device code expired. Start a new login to get another code.'),
  succeeded: t('Copilot is connected. Opening your workspace...'),
  error: t('GitHub login failed. Check your network and Copilot access, then retry.'),
}[login.value.state]))

function changeProvider() {
  model.value = providerPresets.find(item => item.id === provider.value)?.model ?? ''
  baseUrl.value = ''
  apiKey.value = ''
  message.value = ''
}
async function saveProvider() {
  const name = provider.value === 'custom' ? customProvider.value.trim() : provider.value
  saving.value = true
  message.value = ''
  try {
    const result = await client.save({
      provider: instanceId.value, type: props.status?.type ?? name,
      ...(displayName.value.trim() ? { name: displayName.value.trim() } : {}),
      model: model.value.trim(),
      ...(apiKey.value ? { apiKey: apiKey.value } : {}),
      ...(provider.value === 'custom' ? { baseUrl: baseUrl.value.trim() } : {}),
    })
    apiKey.value = ''
    if (result.ready) emit('configured')
    else {
      message.value = t('Configuration was not saved. {value1}', { value1: readinessMessages[result.reason ?? ''] ?? t('Check credentials and connectivity, then retry.') })
    }
  } catch (error) {
    message.value = error instanceof Error ? error.message : t('Could not save the provider. Please retry.')
  } finally {
    saving.value = false
    apiKey.value = ''
  }
}
async function startLogin() {
  if (hostError.value || busy.value) return
  message.value = ''
  copied.value = false
  confirmSignOut.value = false
  signedOut.value = false
  saving.value = true
  try {
    if (props.mode === 'add' || (props.mode === 'setup' && displayName.value.trim())) {
      const type = props.mode !== 'add' && props.status?.provider === instanceId.value && props.status.authMode === 'copilot'
        ? props.status.type ?? 'copilot' : 'copilot-v2'
      await client.instance(instanceId.value, type, displayName.value.trim() || 'GitHub Copilot')
    }
    await controller.start(undefined, normalizeCopilotHost(selectedCopilotHost.value))
  } catch (error) { message.value = error instanceof Error ? error.message : t('Could not save the provider. Please retry.') }
  finally { saving.value = false }
}
async function renameInstance() {
  saving.value = true
  try {
    await client.instance(instanceId.value, props.status?.type ?? props.status?.provider ?? 'copilot', displayName.value.trim())
    emit('configured')
  } catch (error) { message.value = error instanceof Error ? error.message : t('Could not save the provider. Please retry.') }
  finally { saving.value = false }
}
async function signOut() {
  saving.value = true
  message.value = ''
  try {
    await controller.cancel()
    await client.signOut()
    login.value = { state: 'idle' }
    signedOut.value = true
    confirmSignOut.value = false
    emit('configured')
  } catch {
    message.value = t('Copilot sign-out failed. Check Main and access to the application data directory, then retry.')
  } finally {
    saving.value = false
  }
}
async function cancelLogin() { await controller.cancel() }
async function close() { await controller.cancel(); emit('close') }
async function copyCode() {
  try {
    await navigator.clipboard.writeText(login.value.login?.userCode ?? '')
    copied.value = true
  } catch { message.value = t('Clipboard is unavailable. Select and copy the displayed device code manually.') }
}
async function openGitHub() {
  const verificationUri = login.value.login?.verificationUri
  if (login.value.state !== 'pending' || !verificationUri) return
  try {
    if (window.shadowDesktop) {
      // Older preload bridges ignore arguments and always open github.com.
      if (!window.shadowDesktop.openCopilotLogin ||
        (login.value.login?.host !== 'github.com' && login.value.login?.host !== undefined &&
          window.shadowDesktop.copilotLoginHostSupport !== true)) {
        throw new Error(t('Restart Desktop to enable secure login links.'))
      }
      await window.shadowDesktop.openCopilotLogin(verificationUri)
    } else {
      window.open(verificationUri, '_blank', 'noopener,noreferrer')
    }
  } catch { message.value = t('Could not open the browser. Open {uri} manually.', { uri: verificationUri }) }
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
button:where(:not(.ui-select)) { padding: 9px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-soft); font: inherit; cursor: pointer; }
button:where(:not(.ui-select)):disabled { opacity: .55; cursor: not-allowed; } button:where(:not(.ui-select)):focus-visible, input:focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)) { outline: 2px solid var(--c-success); outline-offset: 2px; }
.primary { background: #147a57; border-color: #147a57; color: white; }.actions { justify-content: flex-end; margin-top: 20px; }
.method-panel { display: grid; gap: 12px; } label { display: grid; gap: 6px; font-size: 13px; }
.enterprise-host-field { display: flex; align-items: center; min-width: 0; gap: 8px; }
.enterprise-host-field input { flex: 1; width: 0; }
.enterprise-host-suffix { color: var(--c-text-secondary); white-space: nowrap; }
input, .ui-select { min-width: 0; padding: 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text); font: inherit; }
.help { font-size: 12px; }.notice { padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); line-height: 1.5; }.error { border-color: var(--c-error); color: var(--c-error); }
.device-panel { display: grid; gap: 14px; padding: 20px; background: var(--c-bg-soft); border: 1px solid var(--c-border); border-radius: var(--radius-surface); }.device-panel span { font-size: 13px; color: var(--c-text-secondary); }
.device-code { align-items: center; justify-content: space-between; }.device-code code { -webkit-user-select: text; user-select: text; font: 700 26px monospace; letter-spacing: .08em; }
.footer-actions { margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--c-border); justify-content: space-between; }
@media (max-width: 680px) { .provider-setup { padding: 20px; margin: 12px auto; } }
</style>
