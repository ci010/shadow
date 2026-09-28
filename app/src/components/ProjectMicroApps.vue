<template>
  <section class="micro-apps" aria-label="Project apps">
    <header class="apps-heading">
      <div><h2>Apps</h2><p>Reusable tools for this Project. Your conversations can end; your apps stay.</p></div>
      <button type="button" :disabled="busy" @click="refresh">Refresh</button>
      <button v-if="canWrite" type="button" @click="$emit('compose', 'Build a reusable app for me:\n')">Create with agent</button>
    </header>
    <p v-if="error" class="apps-error" role="alert">{{ error }} <button :disabled="busy" @click="refresh">Retry</button></p>
    <p v-if="loading && !apps.length" class="apps-empty" role="status">Loading apps…</p>
    <div v-else-if="!apps.length && !error" class="apps-empty">
      <h3>A home for the tools you keep using</h3>
      <p>Ask a conversation to build an app. Review its code and permissions here, then open it whenever you need it.</p>
      <p>Publishing does not run code or grant model access.</p>
    </div>
    <div v-else class="apps-layout" :class="{ 'has-selection': !!selected }">
      <nav class="apps-list" aria-label="Saved apps">
        <button v-for="app in apps" :key="app.id" :aria-current="selected?.id === app.id ? 'page' : undefined" @click="select(app.id)">
          <span class="app-identity"><img v-if="app.manifest.icon" :src="microAppIconUrl(apiBase, app)" alt="" @error="iconError" /><strong>{{ app.manifest.name }}</strong></span>
          <span :class="{ 'needs-review': !app.approval }">{{ microAppStatus[app.status] }}</span>
          <span v-if="app.manifest.llm" class="app-usage">{{ app.calls }} / {{ app.manifest.llm.maxCalls }} model calls</span>
        </button>
      </nav>
      <main v-if="selected" class="app-detail">
        <header class="app-heading">
          <div class="app-heading-identity"><img v-if="selected.manifest.icon" :src="microAppIconUrl(apiBase, selected)" alt="" @error="iconError" /><div><h3>{{ selected.manifest.name }}</h3><p>{{ microAppStatus[selected.status] }}</p></div></div>
          <button :disabled="busy" @click="reviewing = !reviewing">{{ reviewing ? 'Hide details' : 'Review details' }}</button>
          <button v-if="selected.approval && canWrite" class="app-primary" :disabled="busy || selected.cleanupPending" @click="open">{{ desktopApps ? 'Open window' : 'Open app' }}</button>
          <button v-if="(selected.status === 'running' || selected.cleanupPending) && canWrite" :disabled="busy" @click="act('stop')">{{ selected.cleanupPending && selected.status === 'failed' ? 'Retry cleanup' : 'Stop' }}</button>
        </header>
        <div v-if="selected.lastRun?.error" class="apps-error" role="status">{{ selected.lastRun.error }}</div>
        <div v-if="reviewing || !selected.approval" class="app-review">
          <p>{{ selected.manifest.description }}</p>
          <dl>
            <dt>Local process</dt><dd>{{ selected.manifest.backend ? `${selected.manifest.backend.runtime}: ${selected.manifest.backend.entry}` : 'None — browser-only app' }}</dd>
            <dt>Model access</dt><dd>{{ selected.manifest.llm ? `${selected.manifest.llm.maxCalls} attempts per approval; up to ${selected.manifest.llm.maxOutputTokens} output tokens each` : 'None' }}</dd>
            <dt>Used allowance</dt><dd>{{ selected.calls }} calls. Stopping or restarting does not reset usage.</dd>
            <dt>Approved model</dt><dd>{{ selected.approval?.model ?? 'Project default at approval, if requested' }}</dd>
            <dt>Version</dt><dd><code>{{ selected.revision }}</code></dd>
          </dl>
          <p class="app-boundary">App pages are isolated from Shadow. A local backend has normal host file and process access — it is not an OS sandbox. Review the code and external effects before approving.</p>
          <details class="app-source">
            <summary>Review source · {{ selected.files.length }} files</summary>
            <details v-for="file in selected.files" :key="file.path"><summary>{{ file.path }} · {{ file.bytes }} bytes</summary>
              <pre v-if="file.text !== undefined"><code>{{ file.text }}</code></pre><p v-else>Binary asset; inspect the source file before approval.</p>
            </details>
          </details>
          <form v-if="canWrite && !selected.cleanupPending && selected.status !== 'running' && selected.status !== 'starting'" class="app-approval" @submit.prevent="approve">
            <label v-if="selected.manifest.llm">Model (optional override)<input v-model="model" placeholder="Use Project default" :disabled="busy" /></label>
            <label class="app-confirm"><input v-model="confirmed" type="checkbox" :disabled="busy" />I reviewed this version and authorize its local code and requested model allowance.</label>
            <button class="app-primary" :disabled="busy || !confirmed">{{ selected.approval ? 'Renew authorization and reset allowance' : 'Approve this version' }}</button>
          </form>
          <button v-if="selected.approval && canWrite" :disabled="busy" @click="act('revoke')">Revoke access and stop</button>
          <p v-if="!canWrite">Project owner access is required to approve or run apps.</p>
        </div>
        <div v-if="frameUrl" class="app-frame">
          <div class="app-frame-tools"><span>Isolated app page</span><button @click="frameUrl = ''">Close page</button></div>
          <iframe :src="frameUrl" :title="selected.manifest.name" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" referrerpolicy="no-referrer" />
        </div>
        <p v-else-if="selected.approval && desktopApps" class="apps-empty" role="status">
          {{ openedNatively ? 'Opened in its own window. You can return to your work here.' : 'This app opens in its own desktop window, not inside the workbench.' }}
          Closing that window stops the app. Its saved data and authorization remain.
        </p>
        <p v-else-if="selected.approval" class="apps-empty">Open the app to use it. Closing its page does not stop its backend; use Stop when finished.</p>
      </main>
      <p v-else class="apps-empty">Select an app to review or open it.</p>
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { microAppIconUrl, microAppRequest, microAppReview, microAppStatus, microAppView, nativeAppIdentity, validAppLaunch, type MicroAppReview, type MicroAppView } from '../microapps.ts'
import { z } from 'zod'
const props = defineProps<{ apiBase: string; active: boolean; canWrite: boolean }>()
defineEmits<{ compose: [text: string] }>()
const route = useRoute(), router = useRouter()
const desktopApps = window.shadowDesktop?.microApps
const apps = ref<MicroAppView[]>([]), selected = ref<MicroAppReview>()
const loading = ref(false), mutating = ref(false), error = ref(''), confirmed = ref(false), model = ref('')
const frameUrl = ref(''), reviewing = ref(true)
const openedNatively = ref(false)
const busy = computed(() => loading.value || mutating.value)
let controller: AbortController | undefined
async function loadSelection(id: string, signal?: AbortSignal) {
  const value = microAppReview.parse(await microAppRequest(props.apiBase, `/${encodeURIComponent(id)}`, undefined, signal))
  if (signal?.aborted) return
  if (selected.value?.id !== id || selected.value.revision !== value.revision) {
    frameUrl.value = ''; confirmed.value = false; model.value = ''; reviewing.value = true; openedNatively.value = false
  }
  if (value.status !== 'running') { frameUrl.value = ''; openedNatively.value = false }
  selected.value = value
}
async function refresh() {
  controller?.abort()
  const request = new AbortController(); controller = request
  loading.value = true; error.value = ''
  try {
    const value = z.object({ apps: z.array(microAppView) }).parse(await microAppRequest(props.apiBase, '', undefined, request.signal))
    if (request.signal.aborted) return
    apps.value = value.apps
    const id = typeof route.query.microApp === 'string' ? route.query.microApp : selected.value?.id
    if (id) await loadSelection(id, request.signal)
  } catch (cause) { if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load apps' }
  finally { if (controller === request) loading.value = false }
}
async function select(id: string) { await router.replace({ query: { ...route.query, microApp: id } }) }
async function mutation(operation: (id: string) => Promise<void>) {
  if (!selected.value || busy.value) return
  mutating.value = true; error.value = ''
  const id = selected.value.id
  try {
    await operation(id)
    confirmed.value = false
    await refresh()
    await desktopApps?.refresh()
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : 'App operation failed'
    await refresh()
    error.value = error.value ? `${message} ${error.value}` : message
  }
  finally { mutating.value = false }
}
function approve() {
  if (!confirmed.value || !selected.value) return
  const revision = selected.value.revision
  return mutation(async id => { await microAppRequest(props.apiBase, `/${id}/approve`, { revision, confirm: true, ...(model.value.trim() ? { model: model.value.trim() } : {}) }) })
}
function act(action: 'stop' | 'revoke') {
  frameUrl.value = ''
  return mutation(async id => { await microAppRequest(props.apiBase, `/${id}/${action}`, {}) })
}
function open() {
  return mutation(async id => {
    if (desktopApps) {
      await desktopApps.open(nativeAppIdentity(props.apiBase, id))
      openedNatively.value = true
      frameUrl.value = ''
    } else frameUrl.value = validAppLaunch(await microAppRequest(props.apiBase, `/${id}/open`, {}))
    reviewing.value = false
  })
}
function iconError() { error.value = 'App icon could not be loaded. Refresh the app review to check its current version.' }
watch(() => props.apiBase, () => { controller?.abort(); apps.value = []; selected.value = undefined; frameUrl.value = ''; openedNatively.value = false })
watch(() => [props.apiBase, props.active, route.query.microApp], () => {
  if (props.active) void refresh()
  else controller?.abort()
}, { immediate: true })
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.micro-apps { display: flex; flex: 1; flex-direction: column; min-height: 0; min-width: 0; color: var(--c-text); overflow: auto; }
.apps-heading, .app-heading { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 16px; border-bottom: 1px solid var(--c-border); }
.apps-heading > div, .app-heading > div { flex: 1; min-width: 160px; }
h2, h3, p { margin: 0; }
h2 { font-size: 24px; font-weight: 600; }
h3 { font-size: 16px; font-weight: 600; overflow-wrap: anywhere; }
p { max-width: 72ch; line-height: 1.6; }
.apps-heading p, .app-heading p { margin-top: 4px; font-size: 12px; color: var(--c-text-secondary); }
button { min-height: 34px; padding: 6px 10px; font: inherit; font-size: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .6; cursor: default; }
button:focus-visible, input:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.app-primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); border-color: var(--c-primary-bg); }
.app-primary:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.apps-layout { display: grid; grid-template-columns: 220px minmax(0, 1fr); flex: 1; min-height: 0; }
.apps-list { border-right: 1px solid var(--c-border); padding: 8px; overflow: auto; }
.apps-list button { display: grid; gap: 5px; text-align: left; width: 100%; margin-bottom: 4px; padding: 12px; border-color: transparent; }
.apps-list strong { font-size: 13px; overflow-wrap: anywhere; }
.app-identity, .app-heading-identity { display: flex; align-items: center; gap: 10px; }
.app-identity strong { color: var(--c-text); }
.app-identity img, .app-heading-identity img { width: 32px; height: 32px; flex: 0 0 32px; object-fit: contain; }
.app-heading-identity > div { min-width: 0; }
.apps-list span { font-size: 12px; color: var(--c-text-secondary); }
.apps-list [aria-current] { background: var(--c-selection-bg); border-color: var(--c-selection-border); }
.apps-list .needs-review { color: var(--c-warn); }
.app-detail { display: flex; flex-direction: column; min-width: 0; min-height: 0; overflow: auto; }
.app-review { padding: 18px; font-size: 13px; }
dl { display: grid; grid-template-columns: 140px minmax(0, 1fr); gap: 8px 14px; margin: 20px 0; line-height: 1.5; }
dt { color: var(--c-text-secondary); }
dd { margin: 0; overflow-wrap: anywhere; }
code { font-size: 12px; }
.app-boundary { padding: 12px; background: var(--c-warn-bg); color: var(--c-text); }
.app-source { margin: 18px 0; }
summary { cursor: pointer; padding: 8px 0; overflow-wrap: anywhere; }
pre { max-height: 300px; padding: 12px; overflow: auto; background: var(--c-bg-muted); white-space: pre; }
.app-approval { display: grid; gap: 14px; margin: 18px 0; max-width: 70ch; }
.app-approval label { display: grid; gap: 6px; }
.app-approval input:not([type=checkbox]) { padding: 8px; color: var(--c-text); background: var(--c-bg-input); border: 1px solid var(--c-control-border); }
.app-approval .app-confirm { display: flex; align-items: flex-start; line-height: 1.5; }
.app-confirm input { flex: 0 0 auto; margin-top: 4px; }
.apps-empty { padding: 32px 20px; color: var(--c-text-secondary); font-size: 13px; }
.apps-empty h3 { color: var(--c-text); margin-bottom: 12px; }
.apps-empty p + p { margin-top: 12px; }
.apps-error { margin: 12px 16px; padding: 12px; color: var(--c-error); background: var(--c-error-bg); font-size: 13px; overflow-wrap: anywhere; }
.app-frame { display: flex; flex: 1; flex-direction: column; min-height: 480px; }
.app-frame-tools { display: flex; align-items: center; justify-content: space-between; padding: 6px 12px; font-size: 12px; color: var(--c-text-secondary); }
iframe { flex: 1; width: 100%; min-height: 400px; border: 0; background: white; }
@media (max-width: 700px) {
  button, summary { min-height: 44px; }
  .apps-layout { display: flex; flex-direction: column; }
  .apps-list { display: flex; flex-shrink: 0; gap: 6px; border-right: 0; border-bottom: 1px solid var(--c-border); max-height: 150px; }
  .apps-list button { min-width: 170px; width: auto; }
  .app-detail { overflow: visible; }
  dl { grid-template-columns: 1fr; gap: 4px; }
  dd { margin-bottom: 10px; }
  .app-approval input:not([type=checkbox]) { font-size: 16px; }
}
</style>
