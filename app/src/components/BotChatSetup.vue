<template>
  <section v-if="enabled && (request || error || closeError)" class="bot-chat-setup" :aria-label="t('Private Bot connection')">
    <header><strong>{{ t('Private Bot connection') }}</strong><button :disabled="busy || !request" @click="close('closed')">{{ t('Done') }}</button><button :disabled="busy || !request" @click="close('cancelled')">{{ t('Cancel') }}</button></header>
    <p>{{ t('Use this private card for credentials and owner pairing. Continue other setup in chat. Done closes this card; it does not confirm readiness or deployment.') }} {{ t('Closing does not undo saved connection changes.') }}</p>
    <p v-if="error || closeError" role="alert">{{ error || closeError }} <button :disabled="busy" @click="refresh(true)">{{ t('Reload') }}</button></p>
    <BotConnectionSetup v-if="request && !busy" :key="request.id" :api-base="apiBase" :project-id="projectId" :available="enabled" :active="enabled" compact />
  </section>
</template>
<script setup lang="ts">
import { computed, inject, onBeforeUnmount, ref, watch } from 'vue'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import { conversationStartKey } from '../conversation-start-context.ts'
import { acquireInteractionRead } from '../interaction-resource.ts'
import { isRecord } from '../folders-sidebar.ts'
import { apiUrl } from '../api-url.ts'
import { privateCredentialTransport } from '../credential-requests.ts'
import BotConnectionSetup from './BotConnectionSetup.vue'
import { t } from '../i18n.ts'
const props = defineProps<{ apiBase: string; projectId: string; sessionId: string; active: boolean; canSubmit: boolean }>()
const enabled = computed(() => props.active && props.canSubmit && props.sessionId.startsWith('web:') && privateCredentialTransport(props.apiBase))
const start = inject(conversationStartKey, undefined)
const scopedStart = computed(() => {
  const state = start?.value
  return state?.apiBase === props.apiBase && state.sessionId === props.sessionId ? state : undefined
})
const phase = computed(() => scopedStart.value?.phase ?? (start ? 'pending' : 'http'))
const invited = computed(() => scopedStart.value?.phase === 'socket' && scopedStart.value.data.botSetup?.pending === true)
const canRead = computed(() => enabled.value && (phase.value === 'http' || invited.value))
const request = ref<{ id: string; expiresAt: number } | null>(null)
const error = ref(''), closeError = ref('')
let expiry: ReturnType<typeof setTimeout> | undefined
watch(request, value => {
  clearTimeout(expiry)
  if (value) expiry = setTimeout(() => {
    request.value = null
    closeError.value = ''
    if (shared) { shared.invalidate(); void refresh(true) }
  }, Math.max(0, value.expiresAt - Date.now()))
})
const busy = ref(false)
let controller: AbortController | undefined
const pool = useLiveClientPool()
let shared: ReturnType<typeof acquireInteractionRead> | undefined
let queued = false
let generation = 0
function stop() { generation++; clearTimeout(expiry); controller?.abort(); controller = undefined; shared?.dispose(); shared = undefined; queued = false; request.value = null; error.value = ''; closeError.value = ''; busy.value = false }
function endpoint() { return apiUrl(props.apiBase, '/api/bot-chat-setup/request') }
function readEndpoint() { const url = endpoint(); url.searchParams.set('sessionId', props.sessionId); return url }
// A positive socket marker permits a scoped read. The invitation itself stays
// behind the authorized HTTP endpoint; no project-wide refresh is needed.
async function readInvitation(signal: AbortSignal): Promise<unknown> {
  const response = await fetch(readEndpoint(), {
    cache: 'no-store', redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]),
  })
  if (!response.ok) throw new Error()
  return response.json()
}
async function refresh(fresh = false) {
  if (!canRead.value || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return
  if (controller || busy.value) { queued = true; return }
  const version = generation
  const read = new AbortController()
  controller = read
  try {
    const body = shared ? await shared.load(fresh) : await readInvitation(read.signal)
    if (!isRecord(body)) throw new Error()
    if (version !== generation || read.signal.aborted) return
    error.value = ''
    const next = body.request
    request.value = isRecord(next) && next.projectId === props.projectId && next.sessionId === props.sessionId && typeof next.id === 'string' && typeof next.expiresAt === 'number' && Number.isFinite(next.expiresAt) && next.expiresAt > Date.now() && next.expiresAt <= Date.now() + 10 * 60_000 ? { id: next.id, expiresAt: next.expiresAt } : null
    if (!request.value) closeError.value = ''
  } catch { if (version === generation && !read.signal.aborted) { request.value = null; error.value = t('Could not load setup status. Check your connection and reload.') } }
  finally { if (controller === read) { controller = undefined; if (queued) { queued = false; void refresh() } } }
}
async function close(status: 'closed' | 'cancelled') {
  if (!request.value || busy.value) return
  const version = generation
  busy.value = true
  closeError.value = ''
  const write = new AbortController()
  controller?.abort(); controller = write
  try {
    const response = await fetch(endpoint(), { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: request.value.id, sessionId: props.sessionId, status }), signal: AbortSignal.any([write.signal, AbortSignal.timeout(10000)]) })
    if (!response.ok) throw new Error()
    const result = await response.json()
    if (!isRecord(result) || result.closed !== true) throw new Error()
    if (version === generation) request.value = null
  } catch { if (version === generation && !write.signal.aborted) closeError.value = t('Could not close setup. Refresh status before retrying.') }
  finally { if (version === generation) { busy.value = false; controller = undefined; queued = false; if (shared) { shared.invalidate(); void refresh() } } }
}
watch([() => props.apiBase, () => props.projectId, () => props.sessionId, phase, canRead], (_next, _old, onCleanup) => {
  stop()
  if (!canRead.value) return
  if (phase.value === 'http') {
    shared = acquireInteractionRead(pool, props.apiBase, props.projectId, readEndpoint().toString(), () => { void refresh() })
  } else if (typeof document !== 'undefined') {
    const resume = () => { if (!request.value && !controller && !busy.value) void refresh() }
    document.addEventListener('visibilitychange', resume)
    onCleanup(() => document.removeEventListener('visibilitychange', resume))
  }
  void refresh()
}, { immediate: true, flush: 'sync' })
onBeforeUnmount(stop)
</script>
<style scoped>
.bot-chat-setup { width: calc(100% - 40px); max-width: 620px; max-height: 55dvh; overflow-y: auto; margin: 8px auto; padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); box-sizing: border-box; font-size: 13px; }
header { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; } header strong { flex: 1; }
p { color: var(--c-text-secondary); line-height: 1.5; }
p[role="alert"] { color: var(--c-error); }
button { min-height: 36px; padding: 7px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-card); font: inherit; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .6; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px) { .bot-chat-setup { width: calc(100% - 16px); } }
@media (max-width: 700px), (pointer: coarse) { button { min-height: 44px; } }
</style>
