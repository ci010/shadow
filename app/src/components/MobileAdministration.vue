<template>
  <section class="phone-settings" aria-labelledby="phone-settings-title">
    <h2 id="phone-settings-title">{{ t('Phone access') }}</h2>
    <p>{{ t('Connect the Shadow phone app, not a Child execution device. Desktop administration stays on this computer.') }}</p>
    <p v-if="error" class="phone-error" role="alert">{{ error }}</p>
    <p v-if="status" role="status">{{ status }}</p>
    <template v-if="network">
      <p role="status">{{ network.state === 'listening' ? t('Phone listener is on') : network.state === 'error' ? t('Phone listener could not start') : t('Phone listener is off') }}</p>
      <p v-if="network.error" class="phone-error" role="alert">{{ network.error }}</p>
      <p v-if="network.managedByEnvironment">{{ t('Phone access is managed by SHADOW_MOBILE_* environment overrides. Remove them and restart Main to use app settings.') }}</p>
      <form v-else @submit.prevent="configure(true)">
        <p>{{ t('The private LAN address is selected automatically when enabled. Settings are restored after restart. Retry after changing Wi-Fi or Ethernet.') }}</p>
        <label>{{ t('Phone port (1024–65535)') }} <input v-model.number="port" type="number" min="1024" max="65535" required :disabled="busy" /></label>
        <label class="phone-consent"><input v-model="acknowledged" type="checkbox" :disabled="busy" />{{ t('LAN HTTP is not encrypted: pairing codes, tokens and conversations can be read on this network. Use only a trusted LAN, never forward this port to the internet.') }}</label>
        <button class="btn primary" :disabled="busy || !acknowledged">{{ t('Enable / retry phone access') }}</button>
        <button v-if="network.enabled" type="button" class="btn" :disabled="busy" @click="configure(false)">{{ t('Turn off phone access') }}</button>
      </form>
      <template v-if="network.state === 'listening'">
        <p>{{ t('Enter this address in the Shadow phone app. For HTTP, enable Allow LAN HTTP on the phone too.') }}</p>
        <code>{{ network.endpoint }}</code>
        <p>{{ t('Pairing codes expire in five minutes and work once. Share only with your phone.') }}</p>
        <button type="button" class="btn" :disabled="busy" @click="createPairing">{{ t('Create phone pairing code') }}</button>
        <div v-if="pairing && remaining > 0">
          <label>{{ t('Phone pairing details') }}<textarea readonly :value="pairingText" rows="4" spellcheck="false" /></label>
          <button type="button" class="btn" @click="copy">{{ t('Copy phone pairing details') }}</button>
          <p>{{ t('Expires at') }} {{ new Date(pairing.expiresAt).toLocaleTimeString() }}</p>
        </div>
        <p v-else-if="pairing" role="status">{{ t('Phone pairing code expired. Create another code.') }}</p>
        <h3>{{ t('Paired phone sessions') }}</h3>
        <p v-if="!network.sessions.length">{{ t('No authenticated phone sessions. Refresh after pairing.') }}</p>
        <div v-for="session in network.sessions" :key="session.id" class="phone-session">
          <code>{{ session.id }}</code><span>{{ t('Expires at') }} {{ new Date(session.expiresAt).toLocaleString() }}</span>
          <button type="button" class="btn" :disabled="busy" @click="revoke(session.id)">{{ t('Disconnect phone') }}</button>
        </div>
        <p>{{ t('If the phone cannot connect, check the same LAN, the selected address, port conflicts and OS firewall permission. Shadow does not change your firewall.') }}</p>
      </template>
    </template>
    <button type="button" class="btn" :disabled="busy" @click="refresh">{{ t('Refresh phone access') }}</button>
  </section>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { t } from '../i18n.ts'
import { deviceAdminRequest } from './device-administration.ts'
interface State {
  enabled: boolean; port: number; allowLanHttp: boolean; managedByEnvironment: boolean
  state: 'disabled' | 'listening' | 'error'; endpoint: string | null; error: string | null
  sessions: Array<{ id: string; expiresAt: string }>
}
interface Pairing { url: string; code: string; expiresAt: string }
const props = defineProps<{ apiBase: string }>()
const network = ref<State>()
const port = ref(3125), acknowledged = ref(false), busy = ref(false), error = ref(''), status = ref('')
const pairing = ref<Pairing>(), now = ref(Date.now())
const remaining = computed(() => pairing.value ? Date.parse(pairing.value.expiresAt) - now.value : 0)
const pairingText = computed(() => pairing.value ? `${pairing.value.url}\n${pairing.value.code}\n${pairing.value.expiresAt}` : '')
const controller = new AbortController()
let clock: ReturnType<typeof setInterval> | undefined
async function run(action: () => Promise<void>) {
  if (busy.value) return
  busy.value = true; error.value = ''; status.value = ''
  try { await action() } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Phone access request failed. Retry on the Main desktop.')
  } finally { busy.value = false }
}
async function request(path: string, method = 'GET', body?: unknown) {
  return await deviceAdminRequest(props.apiBase, `/nodes/v1/mobile/${path}`, controller.signal, method, body)
}
function apply(value: unknown) {
  const state = value as State
  if (!state || !['disabled', 'listening', 'error'].includes(state.state) || !Array.isArray(state.sessions) || !Number.isInteger(state.port)) throw new Error(t('Phone access request failed. Retry on the Main desktop.'))
  if (network.value?.endpoint !== state.endpoint) pairing.value = undefined
  network.value = state; port.value = state.port
}
function refresh() { return run(async () => { apply(await request('settings')) }) }
function configure(enabled: boolean) { return run(async () => {
  pairing.value = undefined
  apply(await request('settings', 'PUT', { enabled, port: port.value, allowLanHttp: acknowledged.value }))
}) }
function createPairing() { return run(async () => {
  const value = await request('pairing', 'POST') as Pairing
  if (!value || typeof value.url !== 'string' || typeof value.code !== 'string' || !Number.isFinite(Date.parse(value.expiresAt))) throw new Error(t('Phone access request failed. Retry on the Main desktop.'))
  pairing.value = value; now.value = Date.now()
}) }
function revoke(id: string) { return run(async () => { apply(await request(`sessions/${encodeURIComponent(id)}`, 'DELETE')) }) }
async function copy() {
  try { await navigator.clipboard.writeText(pairingText.value); status.value = t('Phone pairing details copied.') }
  catch { error.value = t('Clipboard unavailable. Select and copy the pairing details above.') }
}
onMounted(() => { void refresh(); clock = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => { controller.abort(); clearInterval(clock); pairing.value = undefined })
</script>
<style scoped>
.phone-settings { border-top: 1px solid var(--c-border); padding-top: 20px; margin-top: 20px; display: grid; gap: 12px; min-width: 0; }
h2 { font-size: 15px; font-weight: 600; } h3 { font-size: 13px; font-weight: 600; }
p { color: var(--c-text-secondary); font-size: 13px; } form { display: grid; gap: 12px; }
label { display: grid; gap: 6px; font-size: 13px; } .phone-consent { display: flex; align-items: flex-start; color: var(--c-warn); }
input[type=number], textarea { background: var(--c-bg-input); color: var(--c-text); border: 1px solid var(--c-control-border); padding: 8px; max-width: 100%; }
textarea { width: 100%; font-family: var(--font-mono, monospace); } code { overflow-wrap: anywhere; font-size: 12px; }
.phone-error { color: var(--c-error); } .phone-session { display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
button { justify-self: start; } input:focus-visible, textarea:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
