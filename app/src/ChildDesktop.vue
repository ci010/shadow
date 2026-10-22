<template>
  <DesktopFrame>
    <template #navigation><span class="child-role">{{ t('Child · Local status and nodes') }}</span></template>
    <main class="child-shell">
      <DesktopRoleSettings />
      <section class="child-status" aria-labelledby="child-title">
        <header><h1 id="child-title">{{ t('This Child') }}</h1><button class="btn" :disabled="loading" @click="refresh">{{ loading ? t('Refreshing…') : error ? t('Retry local connection') : t('Refresh status') }}</button></header>
        <p v-if="error" role="alert" class="status-error">{{ error }} {{ t('Main connection is unknown; no connected state is assumed.') }}</p>
        <template v-if="status">
          <p role="status"><strong>{{ error ? t('Local status unavailable') : status.connection === 'connected' ? t('Connected to Main') : status.connection === 'connecting' ? t('Connecting to Main — approval may still be pending') : t('Not connected to Main') }}</strong></p>
          <p v-if="!error && status.error" class="status-error">{{ status.error }}</p>
          <p v-if="status.connection !== 'connected'">{{ t('Connection retries automatically with the saved identity, including while this window is hidden and after restart. Check Main\'s pending devices before creating another offer.') }}</p>
          <p>{{ t('Closing this window keeps Child running in the background. Reopen it from the Shadow tray/menu-bar icon. Choose Quit in that menu to stop the node.') }}</p>
          <dl>
            <div><dt>{{ t('Device fingerprint') }}</dt><dd class="fingerprint">{{ status.fingerprint }}</dd></div>
            <div><dt>{{ t('Main device endpoint') }}</dt><dd>{{ status.mainEndpoint }}</dd></div>
            <div><dt>{{ t('Child home') }}</dt><dd>{{ status.dataDir }}</dd></div>
            <div v-for="workdir in status.workdirs" :key="workdir.capabilityId"><dt>{{ workdir.displayName }}</dt><dd>{{ workdir.rootPath }}</dd></div>
          </dl>
          <p>{{ t('Compare this fingerprint with the pending device on Main. Approve only if they match. Local setup completion does not mean approval.') }}</p>
          <p v-if="status.allowInsecureLocalTransport && status.mainEndpoint.startsWith('http:')">{{ t('Trusted LAN/VPN HTTP test transport: traffic is unencrypted; device authentication is still required.') }}</p>
          <details><summary>{{ t('Execution access on this computer') }}</summary><p>{{ t('The approved Main may use the shared work folder, managed session workdirs under Child home, and shell commands as your OS account. Shell access is not a sandbox. These advertised capabilities become available after device approval.') }}</p></details>
        </template>
        <p class="scope-note">{{ t('Main workspace is available automatically after device approval. This local status and inventory remain available when Main is offline.') }}</p>
      </section>
      <NodesView :api-base="apiBase" />
    </main>
  </DesktopFrame>
</template>

<script setup lang="ts">
import DesktopRoleSettings from './components/DesktopRoleSettings.vue'
import { t } from './i18n.ts'
import { onMounted, onBeforeUnmount, ref, provide, readonly } from 'vue'
import DesktopFrame from './DesktopFrame.vue'
import NodesView from './components/NodesView.vue'
import { parseChildStatus, type ChildStatus } from './child-status.ts'

import { installationContextKey, useInstallationContext } from './composables/useInstallationContext.ts'
const inheritedContext = useInstallationContext()
provide(installationContextKey, readonly(ref({ ...inheritedContext.value, mainWorkspace: false, uiScopes: [] })))

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
    if (!response.ok) throw new Error(t('Local Child status request failed'))
    const next = parseChildStatus(await response.json())
    if (request !== current) return
    status.value = next
    error.value = ''
  } catch {
    if (request !== current || disposed) return
    error.value = t('Cannot reach the local Child runtime. Retry, or restart Shadow if the backend stopped.')
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
.fingerprint { font-family: var(--font-mono, monospace); -webkit-user-select: all; user-select: all; }
.status-error { color: var(--c-error); }
.scope-note { color: var(--c-text-muted); }
summary { cursor: pointer; font-size: 13px; }
@media (max-width: 620px) { .child-shell { padding: 16px; } dl > div { grid-template-columns: 1fr; gap: 4px; } header { align-items: flex-start; } }
</style>
