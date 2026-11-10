<template>
  <div class="method-panel">
    <h2>DeepSeek Account</h2>
    <p>{{ t('Sign in through the official DeepSeek platform. Model access, authorization and charges are controlled by DeepSeek; this is not a free API guarantee.') }}</p>
    <p>{{ t('DeepSeek must grant third-party account access. Live authorization for Shadow has not been verified.') }}</p>
    <label>{{ t('Connection model') }}
      <UiSelect v-model="model" :disabled="busy">
        <option value="deepseek-v4-flash">deepseek-v4-flash</option>
        <option value="deepseek-v4-pro">deepseek-v4-pro</option>
      </UiSelect>
    </label>
    <p v-if="message" role="status" aria-live="polite">{{ message }}</p>
    <a v-if="authorizeUrl" :href="authorizeUrl" target="_blank" rel="noopener noreferrer" @click="openBrowser">{{ t('Open DeepSeek authorization') }}</a>
    <div class="actions">
      <button v-if="!busy" type="button" :disabled="!name.trim()" @click="start">{{ t('Sign in with DeepSeek Account') }}</button>
      <button v-else type="button" @click="cancel">{{ t('Cancel login') }}</button>
      <button v-if="editing && !busy" type="button" @click="save">{{ t('Save provider connection') }}</button>
      <button v-if="editing && !busy" type="button" @click="logout">{{ t('Sign out of DeepSeek Account') }}</button>
    </div>
  </div>
</template>
<script setup lang="ts">
import { onBeforeUnmount, ref, watch } from 'vue'
import { t } from './i18n.ts'
import { apiUrl, hostBase } from './api-url.ts'
import { createProviderSetupClient } from './provider-setup.ts'
import UiSelect from './components/UiSelect.vue'

const props = defineProps<{ apiBase: string; provider: string; name: string; editing: boolean; active?: boolean; initialModel?: string }>()
const emit = defineEmits<{ configured: []; busy: [value: boolean] }>()
const model = ref(props.initialModel?.split('@')[0] || 'deepseek-v4-flash')
const busy = ref(false)
const message = ref('')
const authorizeUrl = ref('')
let loginId = ''
let timer: ReturnType<typeof setTimeout> | undefined
let generation = 0
let disposed = false
const client = createProviderSetupClient(hostBase(props.apiBase))
watch(busy, value => emit('busy', value), { flush: 'sync' })
const url = (suffix: string) => apiUrl(hostBase(props.apiBase), `/api/deepseek-account/${suffix}${suffix.includes('?') ? '&' : '?'}provider=${encodeURIComponent(props.provider)}`)
async function call(suffix: string, method = 'GET') {
  const response = await fetch(url(suffix), { method, headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000), ...(method === 'DELETE' ? { keepalive: true } : {}) })
  if (!response.ok) throw new Error(t('DeepSeek Account request failed. Check service availability and third-party access, then retry.'))
  return response.json()
}
function browserDestination(value: unknown): string {
  if (typeof value !== 'string') return ''
  const parsed = new URL(value)
  if (parsed.origin !== 'https://platform.deepseek.com' || parsed.pathname !== '/dsh/authorize' || parsed.username || parsed.password || parsed.hash) throw new Error('Invalid DeepSeek authorization destination')
  return parsed.href
}
async function openBrowser(event?: MouseEvent) {
  if (!authorizeUrl.value) return
  if (window.shadowDesktop) {
    event?.preventDefault()
    try {
      if (!window.shadowDesktop.openExternal) throw new Error('Desktop browser bridge unavailable')
      await window.shadowDesktop.openExternal(authorizeUrl.value)
    }
    catch { message.value = t('Open the DeepSeek authorization link in your system browser.') }
  }
}
async function save() {
  busy.value = true
  try {
    const result = await client.save({ provider: props.provider, type: 'deepseek-account', name: props.name.trim(), model: model.value })
    if (result.ready) emit('configured')
    else message.value = t('Sign in to DeepSeek Account before saving this connection.')
  } catch { message.value = t('Could not save the provider. Please retry.') }
  finally { busy.value = false }
}
async function observe(value: { loginId: string; state: string; authorizeUrl?: unknown }, current: number) {
  if (disposed || generation !== current) return
  loginId = value.loginId
  authorizeUrl.value = browserDestination(value.authorizeUrl)
  if (value.state === 'pending') {
    message.value = t('Waiting for DeepSeek authorization. Complete sign-in in your browser.')
    timer = setTimeout(async () => {
      try { await observe(await call(`login/${encodeURIComponent(loginId)}`), current) }
      catch { if (generation === current && !disposed) { busy.value = false; message.value = t('DeepSeek Account request failed. Check service availability and third-party access, then retry.') } }
    }, 1000)
  } else {
    busy.value = false
    authorizeUrl.value = ''
    if (value.state === 'succeeded') await save()
    else message.value = t('DeepSeek sign-in did not complete. You can start a new login.')
  }
}
async function start() {
  const current = ++generation
  busy.value = true
  message.value = ''
  try {
    await client.instance(props.provider, 'deepseek-account', props.name.trim())
    if (disposed || generation !== current) return
    const value = await call('login', 'POST')
    if (disposed || generation !== current) { await call(`login/${encodeURIComponent(value.loginId)}`, 'DELETE'); return }
    await observe(value, current)
    if (window.shadowDesktop && authorizeUrl.value && !disposed && generation === current) await openBrowser()
    // Browser must be opened by a user gesture: the validated link remains available.
  } catch {
    if (!disposed && generation === current) { busy.value = false; message.value = t('DeepSeek Account request failed. Check service availability and third-party access, then retry.') }
  }
}
async function cancel() {
  ++generation
  clearTimeout(timer)
  authorizeUrl.value = ''
  busy.value = false
  const id = loginId
  loginId = ''
  if (id) try { await call(`login/${encodeURIComponent(id)}`, 'DELETE') } catch { if (!disposed) message.value = t('DeepSeek Account request failed. Check service availability and third-party access, then retry.') }
}
async function logout() {
  busy.value = true
  try { await cancel(); busy.value = true; await call('logout', 'POST'); message.value = t('Signed out of this DeepSeek Account connection.'); emit('configured') }
  catch { message.value = t('DeepSeek Account request failed. Check service availability and third-party access, then retry.') }
  finally { busy.value = false }
}
watch(() => props.active, active => { if (active === false) void cancel() })
const leave = () => { void cancel() }
window.addEventListener('beforeunload', leave)
onBeforeUnmount(() => { disposed = true; window.removeEventListener('beforeunload', leave); void cancel() })
</script>
<style scoped>
.method-panel { display: flex; flex-direction: column; gap: 16px; }
h2, p { margin: 0; }
p { color: var(--c-text-secondary); line-height: 1.6; }
label { display: flex; flex-direction: column; gap: 8px; }
.actions { display: flex; flex-wrap: wrap; gap: 8px; }
button { min-height: 36px; padding: 8px 12px; color: var(--c-text); background: var(--c-bg-soft); border: 1px solid var(--c-border); border-radius: var(--radius-control); cursor: pointer; }
a { color: var(--c-blue); overflow-wrap: anywhere; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
button:disabled { opacity: .55; cursor: not-allowed; }
</style>
