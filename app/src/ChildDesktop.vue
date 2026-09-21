<template>
  <DesktopFrame>
    <template #navigation><span class="child-role">Child · Local status and nodes</span></template>
    <main class="child-shell">
      <section class="child-status" aria-labelledby="child-title">
        <header><h1 id="child-title">This Child</h1><button class="btn" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : error ? 'Retry local connection' : 'Refresh status' }}</button></header>
        <p v-if="error" role="alert" class="status-error">{{ error }} Main connection is unknown; no connected state is assumed.</p>
        <template v-if="status">
          <p role="status"><strong>{{ error ? 'Local status unavailable' : status.connection === 'connected' ? 'Connected to Main' : status.connection === 'connecting' ? 'Connecting to Main — approval may still be pending' : 'Not connected to Main' }}</strong></p>
          <p v-if="!error && status.error" class="status-error">{{ status.error }}</p>
          <p v-if="status.connection !== 'connected'">Keep this window open. Connection retries automatically with the saved identity, including after restart. Check Main's pending devices before creating another offer.</p>
          <dl>
            <div><dt>Device fingerprint</dt><dd class="fingerprint">{{ status.fingerprint }}</dd></div>
            <div><dt>Main device endpoint</dt><dd>{{ status.mainEndpoint }}</dd></div>
            <div><dt>Child home</dt><dd>{{ status.dataDir }}</dd></div>
            <div v-for="workdir in status.workdirs" :key="workdir.capabilityId"><dt>{{ workdir.displayName }}</dt><dd>{{ workdir.rootPath }}</dd></div>
          </dl>
          <p>Compare this fingerprint with the pending device on Main. Approve only if they match. Local setup completion does not mean approval.</p>
          <p v-if="status.allowInsecureLocalTransport && status.mainEndpoint.startsWith('http:')">Trusted LAN/VPN HTTP test transport: traffic is unencrypted; device authentication is still required.</p>
          <details><summary>Execution access on this computer</summary><p>The approved Main may use the shared work folder, managed session workdirs under Child home, and shell commands as your OS account. Shell access is not a sandbox. These advertised capabilities become available after device approval.</p></details>
        </template>
        <p class="scope-note">Chat and Main administration are not proxied on Child. Use Main for those tasks. This page and the local inventory remain available when Main is offline.</p>
      </section>
      <NodesView :api-base="apiBase" />
    </main>
  </DesktopFrame>
</template>

<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref } from 'vue'
import DesktopFrame from './DesktopFrame.vue'
import NodesView from './components/NodesView.vue'
import { parseChildStatus, type ChildStatus } from './child-status.ts'

const props = defineProps<{ apiBase: string }>()
const status = ref<ChildStatus | null>(null)
const error = ref('')
const loading = ref(false)
let timer: ReturnType<typeof setTimeout> | undefined
let request: AbortController | undefined
let disposed = false
async function refresh() {
  clearTimeout(timer)
  request?.abort()
  const current = new AbortController()
  request = current
  loading.value = true
  try {
    const response = await fetch(`${props.apiBase}/local/v1/child`, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(5000)]), cache: 'no-store' })
    if (!response.ok) throw new Error('Local Child status request failed')
    const next = parseChildStatus(await response.json())
    if (request !== current) return
    status.value = next
    error.value = ''
  } catch {
    if (request !== current || disposed) return
    error.value = 'Cannot reach the local Child runtime. Retry, or restart Shadow if the backend stopped.'
  } finally {
    if (request === current && !disposed) {
      loading.value = false
      timer = setTimeout(refresh, 3000)
    }
  }
}
onMounted(refresh)
onBeforeUnmount(() => { disposed = true; clearTimeout(timer); request?.abort() })
</script>

<style scoped>
.child-role { font-size: 13px; color: var(--c-text-secondary); }
.child-shell { max-width: 1120px; margin: 0 auto; padding: 24px; color: var(--c-text); }
.child-status { border-bottom: 1px solid var(--c-border); padding-bottom: 24px; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px; }
h1 { margin: 0; font-size: 24px; font-weight: 600; }
p { max-width: 75ch; font-size: 14px; line-height: 1.6; }
dl { margin: 24px 0; }
dl > div { display: grid; grid-template-columns: 180px minmax(0, 1fr); gap: 16px; padding: 8px 0; }
dt { color: var(--c-text-muted); font-size: 13px; }
dd { margin: 0; overflow-wrap: anywhere; font-size: 13px; }
.fingerprint { font-family: var(--font-mono, monospace); user-select: all; }
.status-error { color: var(--c-error); }
.scope-note { color: var(--c-text-muted); }
summary { cursor: pointer; font-size: 13px; }
@media (max-width: 620px) { .child-shell { padding: 16px; } dl > div { grid-template-columns: 1fr; gap: 4px; } header { align-items: flex-start; } }
</style>
