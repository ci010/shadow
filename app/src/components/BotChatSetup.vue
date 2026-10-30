<template>
  <section v-if="enabled && (request || error)" class="bot-chat-setup" aria-label="Bot setup in Chat">
    <header><strong>Bot setup in Chat</strong><button :disabled="busy" @click="close('closed')">Done</button><button :disabled="busy" @click="close('cancelled')">Cancel</button></header>
    <p>Enter credentials only in this private card, never in a chat message. Closing does not prove the Bot is ready. Service Agent publication is a separate restricted workflow.</p>
    <p v-if="error" role="alert">{{ error }} <button :disabled="busy" @click="refresh()">Reload</button></p>
    <ChannelsView v-if="request" :key="request?.id" :api-base="apiBase" :project-id="projectId" :available="enabled" :active="enabled" />
  </section>
</template>
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import { observeInteractions } from '../interaction-resource.ts'
import { apiUrl } from '../api-url.ts'
import { privateCredentialTransport } from '../credential-requests.ts'
import ChannelsView from './ChannelsView.vue'
const props = defineProps<{ apiBase: string; projectId: string; sessionId: string; active: boolean; canSubmit: boolean }>()
const enabled = computed(() => props.active && props.canSubmit && props.sessionId.startsWith('web:') && privateCredentialTransport(props.apiBase))
const request = ref<{ id: string; expiresAt: number } | null>(null)
const error = ref('')
const busy = ref(false)
let controller: AbortController | undefined
const pool = useLiveClientPool()
let observer: ReturnType<typeof observeInteractions> | undefined
let queued = false
let generation = 0
function stop() { generation++; controller?.abort(); controller = undefined; observer?.dispose(); observer = undefined; queued = false; request.value = null; error.value = ''; busy.value = false }
function endpoint() { return apiUrl(props.apiBase, '/api/bot-chat-setup/request') }
async function refresh() {
  if (!enabled.value || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
  if (controller || busy.value) { queued = true; return }
  const version = generation
  const read = new AbortController()
  controller = read
  try {
    const url = endpoint(); url.searchParams.set('sessionId', props.sessionId)
    const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([read.signal, AbortSignal.timeout(10000)]) })
    if (!response.ok) throw new Error()
    const body = await response.json()
    if (version !== generation || read.signal.aborted) return
    error.value = ''
    const next = body.request
    request.value = next && next.projectId === props.projectId && next.sessionId === props.sessionId && typeof next.id === 'string' && next.expiresAt > Date.now() ? next : null
  } catch { if (version === generation && !read.signal.aborted) { request.value = null; error.value = 'Could not load setup status. Check your connection and reload.' } }
  finally { if (controller === read) { controller = undefined; if (queued) { queued = false; void refresh() } } }
}
async function close(status: 'closed' | 'cancelled') {
  if (!request.value || busy.value) return
  const version = generation
  busy.value = true
  const write = new AbortController()
  controller?.abort(); controller = write
  try {
    const response = await fetch(endpoint(), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: request.value.id, sessionId: props.sessionId, status }), signal: AbortSignal.any([write.signal, AbortSignal.timeout(10000)]) })
    if (!response.ok) throw new Error()
    if (version === generation) request.value = null
  } catch { if (version === generation && !write.signal.aborted) error.value = 'Could not close setup. Refresh status before retrying.' }
  finally { if (version === generation) { busy.value = false; controller = undefined; queued = false; void refresh() } }
}
watch([() => props.apiBase, () => props.projectId, () => props.sessionId, enabled], () => { stop(); if (enabled.value) { observer = observeInteractions(pool, props.apiBase, props.projectId, () => { void refresh() }, () => { if (!busy.value) { controller?.abort(); controller = undefined; queued = false } }) } }, { immediate: true })
onBeforeUnmount(stop)
</script>
<style scoped>
.bot-chat-setup { width: calc(100% - 40px); max-width: 860px; max-height: 55dvh; overflow-y: auto; margin: 8px auto; padding: 16px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); box-sizing: border-box; }
header { display: flex; gap: 12px; align-items: center; } header strong { flex: 1; }
</style>
