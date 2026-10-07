<template>
  <DisplaySourcePicker />
  <aside v-if="owned && !inConversation" class="capture-status" :aria-label="t('Active capture in another conversation')">
    <span class="capture-dot" :class="{ recording: execution?.phase === 'recording' }" aria-hidden="true" />
    <span role="status">{{ statusText }} · {{ execution!.run.definition.title }}</span>
    <button type="button" @click="$emit('openConversation', { projectId: execution!.run.projectId, sessionId: execution!.run.sessionId })">{{ t('Open conversation') }}</button>
    <button v-if="execution?.phase === 'recording'" type="button" @click="execution.finish()">{{ t('Stop recording') }}</button>
    <button v-else type="button" @click="execution?.cancel()">{{ t('Cancel') }}</button>
  </aside>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { computed, onBeforeUnmount, onMounted, triggerRef, watch } from 'vue'
import { parseIoDefinition, type IoRun } from '../../../../src/io/contracts.ts'
import { apiUrl } from '../../api-url.ts'
import { createUuid } from '../../uuid.ts'
import { parseSessionDetails } from '../../session-details.ts'
import { liveProjectId, useLiveClientPool } from '../../composables/useLiveClient.ts'
import type { LiveSubscription } from '../../live-client.ts'
import { browserIoCapabilities } from '../../io/adapters.ts'
import { IoExecution } from '../../io/execution.ts'
import { ioRunKey, type IoBridge } from '../../io/bridge.ts'
import { IoRequestError, ioRequest } from '../../io/transport.ts'
import { desktopIoIssue } from '../../io/desktop.ts'
import { mobileCaptureIssue } from '../../io/mobile-policy.ts'
import DisplaySourcePicker from './DisplaySourcePicker.vue'

const { bridge } = defineProps<{ bridge: IoBridge }>()
defineEmits<{ openConversation: [context: { projectId: string; sessionId: string }] }>()
const execution = bridge.execution
const owned = computed(() => !!execution.value && execution.value.phase !== 'closed')
const inConversation = computed(() => [...bridge.views.value.values()].some(view =>
  view.apiBase === bridge.executionBase.value && view.sessionId === execution.value?.run.sessionId))
const statusText = computed(() => execution.value?.phase === 'recording' ? t('Recording')
  : execution.value?.phase === 'processing' ? t('Processing input') : execution.value?.phase === 'ready' ? t('Input ready')
  : execution.value?.phase === 'draining' ? t('Finishing input') : t('Preparing input'))
const livePool = useLiveClientPool()
const subscriptions = new Map<string, LiveSubscription>()
const clients = new Map<string, { clientId: string; clientToken: string }>()
const registrations = new Map<string, { promise: Promise<{ clientId: string; clientToken: string }>; controller: AbortController }>()
const attempted = new Set<string>()
const capabilities = browserIoCapabilities()
let disposed = false
let polling = false
let leaseBusy = false
let generation = 0
let pollTimer: ReturnType<typeof setInterval>
let leaseTimer: ReturnType<typeof setInterval>
let clockTimer: ReturnType<typeof setInterval>
const bases = computed(() => new Set([
  ...[...bridge.views.value.values()].map(view => view.apiBase),
  ...(owned.value ? [bridge.executionBase.value] : []),
]))

function setError(key: string, message = '') {
  const errors = new Map(bridge.errors.value)
  if (message) errors.set(key, message)
  else errors.delete(key)
  bridge.errors.value = errors
}
function putRun(base: string, run: IoRun) {
  const all = new Map(bridge.runs.value)
  const runs = [...all.get(base) ?? []]
  const index = runs.findIndex(item => item.id === run.id)
  if (index < 0) runs.push(run)
  else runs[index] = run
  all.set(base, runs)
  bridge.runs.value = all
}
async function client(base: string) {
  const existing = clients.get(base)
  if (existing) return existing
  const pending = registrations.get(base)
  if (pending) return pending.promise
  const controller = new AbortController()
  const registration = (async () => {
    const clientId = createUuid()
    const result = await ioRequest<{ clientToken: string }>(base, '/clients', { id: clientId, name: 'Local capture client', capabilities },
      AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
    controller.signal.throwIfAborted()
    if (disposed || !bases.value.has(base)) throw new DOMException(t('Capture view closed'), 'AbortError')
    if (!result || typeof result.clientToken !== 'string' || !result.clientToken) throw new Error(t('Invalid capture client registration'))
    const registered = { clientId, clientToken: result.clientToken }
    clients.set(base, registered)
    return registered
  })().finally(() => {
    if (registrations.get(base)?.controller === controller) registrations.delete(base)
  })
  registrations.set(base, { promise: registration, controller })
  return registration
}
function forgetClient(base: string) {
  clients.delete(base)
  registrations.get(base)?.controller.abort()
  registrations.delete(base)
}
async function poll() {
  if (polling || disposed || (document.hidden && !owned.value)) return
  polling = true
  try {
    await Promise.all([...bases.value].map(async base => {
      try {
        await client(base)
        const result = await ioRequest<{ runs: IoRun[] }>(base, '/runs')
        if (disposed || !bases.value.has(base)) return
        const sessions = new Set([...bridge.views.value.values()].filter(view => view.apiBase === base).map(view => view.sessionId))
        const sorted = result.runs.filter(run => sessions.has(run.sessionId)).toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        const runs = sorted.filter((run, index) => index < 32 || ['awaiting_consent', 'running', 'stopping'].includes(run.status))
        const active = execution.value
        if (active && bridge.executionBase.value === base && active.phase !== 'closed') {
          const index = runs.findIndex(run => run.id === active.run.id)
          if (index < 0) runs.push(active.run)
          else runs[index] = active.run
        }
        const all = new Map(bridge.runs.value)
        all.set(base, runs); bridge.runs.value = all
        setError(base)
      } catch (cause) {
        if (disposed || !bases.value.has(base) || (cause instanceof DOMException && cause.name === 'AbortError')) return
        setError(base, cause instanceof Error ? cause.message : t('Could not load capture requests.'))
      }
    }))
    if (!owned.value && !bridge.busy.value) {
      const views = [...bridge.views.value.values()]
      const current = views.find(view => view === bridge.context.value) ?? views[0]
      const requested = current && !current.remote && bridge.runs.value.get(current.apiBase)?.find(run =>
        run.status === 'awaiting_consent' && run.sessionId === current.sessionId && !attempted.has(ioRunKey(current.apiBase, run.id)))
      if (requested && current) void prepare(requested, current.apiBase)
    }
  } finally { polling = false }
}
async function prepare(run: IoRun, base: string) {
  if (owned.value || bridge.busy.value || disposed) return
  const token = ++generation
  const key = ioRunKey(base, run.id)
  bridge.busy.value = key; attempted.add(key); setError(key)
  execution.value?.dispose(); execution.value = undefined
  try {
    const snapshot = await ioRequest<IoRun>(base, `/runs/${encodeURIComponent(run.id)}`)
    snapshot.definition = parseIoDefinition(snapshot.definition)
    if (token !== generation || disposed) return
    putRun(base, snapshot)
    if (snapshot.status !== 'awaiting_consent') return
    const issue = mobileCaptureIssue(snapshot.definition.sources) ?? desktopIoIssue(snapshot.definition)
    if (issue) throw new Error(issue)
    const response = await fetch(apiUrl(base, `/api/sessions/${encodeURIComponent(snapshot.sessionId)}/details`), { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(t('Could not check the conversation workdir. Retry the connection.'))
    if (parseSessionDetails(await response.json(), snapshot.sessionId).workdir.kind === 'remote') throw new Error(t('Device capture needs a local conversation.'))
    const credentials = await client(base)
    const result = await ioRequest<{ leaseToken: string; run: IoRun }>(base, `/runs/${encodeURIComponent(run.id)}/prepare`, { ...credentials, revision: snapshot.revision }, AbortSignal.timeout(20_000))
    if (token !== generation || disposed) {
      await ioRequest(base, `/runs/${encodeURIComponent(run.id)}/stop`, { status: 'cancelled' })
      return
    }
    if (result.run.revision !== snapshot.revision) throw new Error(t('The requested input changed. Ask for a new request.'))
    bridge.executionBase.value = base
    const current = new IoExecution({
      base, run: result.run, grant: { ...credentials, leaseToken: result.leaseToken },
      change() { triggerRef(execution); putRun(base, current.run) },
    })
    execution.value = current
    putRun(base, current.run)
    current.connect()
  } catch (cause) { setError(key, cause instanceof Error ? cause.message : t('Could not prepare input. Retry the connection.')) }
  finally { if (token === generation) bridge.busy.value = undefined }
}
function current(id: string, base: string) {
  return execution.value?.run.id === id && bridge.executionBase.value === base ? execution.value : undefined
}
bridge.actions.value = {
  prepare,
  start(id, base, inputs) { void current(id, base)?.start(inputs) },
  finish(id, base) { void current(id, base)?.finish() },
  async cancel(run, base, denied = false) {
    const active = current(run.id, base)
    if (active) await active.cancel(denied ? 'denied' : 'cancelled')
    else {
      const key = ioRunKey(base, run.id)
      if (bridge.busy.value) return
      bridge.busy.value = key
      try {
        const result = await ioRequest<{ run: IoRun }>(base, `/runs/${encodeURIComponent(run.id)}/stop`, { status: denied ? 'denied' : 'cancelled' })
        putRun(base, result.run)
      } catch (cause) { setError(key, cause instanceof Error ? cause.message : t('Could not cancel this request.')) }
      finally { bridge.busy.value = undefined }
    }
    void poll()
  },
}
async function pulseClients() {
  if (leaseBusy || disposed) return
  leaseBusy = true
  try {
    await Promise.all([...bases.value].map(async base => {
      const credentials = clients.get(base)
      if (!credentials) return
      try { await ioRequest(base, `/clients/${credentials.clientId}/heartbeat`, { clientToken: credentials.clientToken }, AbortSignal.timeout(5000)) }
      catch (cause) {
        if (disposed || !bases.value.has(base) || clients.get(base) !== credentials) return
        clients.delete(base)
        const detail = cause instanceof Error ? cause.message : t('Client disconnected')
        if (owned.value && bridge.executionBase.value === base) await execution.value!.fail(new Error(t('Capture connection lost: {detail}', { detail: detail })))
        else if (cause instanceof IoRequestError && cause.status === 403 && cause.code === 'client_expired') {
          try {
            await client(base)
            if (!disposed && bases.value.has(base)) setError(base)
          } catch (error) {
            if (disposed || !bases.value.has(base) || (error instanceof DOMException && error.name === 'AbortError')) return
            setError(base, error instanceof Error ? error.message : t('Could not reconnect the capture client.'))
          }
        }
        else setError(base, detail)
      }
    }))
  } finally { leaseBusy = false }
}
watch(bases, values => {
  for (const base of new Set([...clients.keys(), ...registrations.keys()])) {
    if (!values.has(base)) { forgetClient(base); setError(base) }
  }
  const retained = new Map(bridge.runs.value)
  for (const base of retained.keys()) if (!values.has(base)) retained.delete(base)
  bridge.runs.value = retained
  for (const [base, subscription] of subscriptions) if (!values.has(base)) { subscription.close(); subscriptions.delete(base) }
  for (const base of values) {
    if (subscriptions.has(base)) continue
    const invalidate = () => { void poll(); if (bridge.executionBase.value === base) execution.value?.invalidate() }
    subscriptions.set(base, livePool.client(base).subscribe({ kind: 'io', projectId: liveProjectId(base) }, { event: invalidate, reset: invalidate }))
  }
  void poll()
}, { immediate: true })
const pageHide = () => { void execution.value?.cancel('cancelled', t('The capture page was closed.')); execution.value?.dispose() }
const visibilityChanged = () => {
  if (!document.hidden) void pulseClients().then(() => poll())
}
onMounted(() => {
  pollTimer = setInterval(() => { void poll() }, 2000)
  leaseTimer = setInterval(() => { void pulseClients() }, 5000)
  clockTimer = setInterval(() => { bridge.clock.value = Date.now(); triggerRef(execution) }, 250)
  window.addEventListener('pagehide', pageHide)
  document.addEventListener('visibilitychange', visibilityChanged)
})
onBeforeUnmount(() => {
  disposed = true; generation++
  clearInterval(pollTimer); clearInterval(leaseTimer); clearInterval(clockTimer)
  window.removeEventListener('pagehide', pageHide)
  document.removeEventListener('visibilitychange', visibilityChanged)
  for (const base of new Set([...clients.keys(), ...registrations.keys()])) forgetClient(base)
  pageHide(); bridge.actions.value = undefined
  for (const subscription of subscriptions.values()) subscription.close()
  subscriptions.clear()
})
</script>

<style scoped>
.capture-status { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 14px; min-height: 38px; padding: 6px 16px; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text-secondary); font-size: 12px; }
.capture-status > span[role] { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.capture-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--c-text-secondary); }
.capture-dot.recording { background: var(--c-error); }
.capture-status button { border: 0; padding: 6px 0; background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.capture-status button:hover { text-decoration: underline; }
.capture-status button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
</style>
