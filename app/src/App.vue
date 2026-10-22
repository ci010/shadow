<template>
  <DesktopFrame :mobile="mobile.enabled.value" :style="mobile.enabled.value ? { '--mobile-viewport-height': `${mobile.viewportHeight.value}px` } : undefined">
    <template #mobile-header><MobileChrome :title="mobilePageTitle" /></template>
    <template #navigation>
      <Teleport :to="mobile.navigationTarget.value || 'body'" :disabled="!mobile.enabled.value || !mobile.navigationTarget.value">
        <nav class="tab-nav" :class="{ 'mobile-app-nav': mobile.enabled.value }" :aria-label="t('Main navigation')">
          <template v-for="group in navigationGroups" :key="group.name">
            <span v-if="group.label" class="tab-group-label">{{ group.label }}</span>
            <router-link v-for="item in group.items" :key="item.name" :to="item.name === 'chat' ? lastChatLocation : item.name === 'agents' ? { name: 'project-settings', params: { projectId: route.params.projectId || 'default', section: 'agents' } } : { name: item.name, params: ['agents', 'spans', 'logs'].includes(item.name) ? { projectId: route.params.projectId || 'default' } : {} }" custom v-slot="{ isActive, navigate }">
              <button class="tab" :class="{ active: isActive }" :aria-current="isActive ? 'page' : undefined" @click="navigate">
                {{ item.label }}
              </button>
            </router-link>
          </template>
        </nav>
      </Teleport>
    </template>
    <template #actions>
      <Teleport :to="mobile.actionsTarget.value || 'body'" :disabled="!mobile.enabled.value || !mobile.actionsTarget.value">
          <DesktopBrowserAccess v-if="isMain && !installationContext.mainWorkspace && desktopWebPairing" :api="desktopWebPairing" />
          <MobileConnection v-if="mobileSession" :session="mobileSession" connected />
          <button v-if="browserSession?.status.value?.required" class="tab" :disabled="browserSession.busy.value" @click="browserSession.logout()">{{ t('Sign out') }}</button>
          <button v-if="browserNotifications" class="theme-toggle" :disabled="browserNotifications.requesting.value"
            :aria-pressed="browserNotifications.active.value"
            :aria-label="browserNotifications.active.value ? t('Disable system notifications') : t('Enable system notifications')"
            :title="browserNotifications.error.value || (browserNotifications.active.value ? t('Disable system notifications') : t('Enable system notifications'))"
            @click="browserNotifications.setEnabled(!browserNotifications.active.value)">
            <span :class="browserNotifications.active.value ? 'i-lucide-bell' : 'i-lucide-bell-off'" class="w-3.5 h-3.5" aria-hidden="true" />
            <span v-if="mobile.enabled.value">{{ t('System notifications') }}</span>
          </button>
          <button class="theme-toggle" :aria-pressed="sounds.preferences.value.enabled"
            :aria-label="sounds.preferences.value.enabled ? t('Mute notification sounds') : t('Enable notification sounds')"
            :title="sounds.error.value || (sounds.preferences.value.enabled ? t('Mute notification sounds') : t('Enable notification sounds'))" @click="toggleSounds">
            <span :class="sounds.preferences.value.enabled ? 'i-lucide-volume-2' : 'i-lucide-volume-x'" class="w-3.5 h-3.5" aria-hidden="true" />
            <span v-if="mobile.enabled.value">{{ sounds.preferences.value.enabled ? t('Mute sounds') : t('Enable sounds') }}</span>
          </button>
          <button class="theme-toggle" @click="toggleTheme" :title="isDark ? t('Switch to light') : t('Switch to dark')" :aria-label="isDark ? t('Switch to light theme') : t('Switch to dark theme')">
            <!-- Sun icon (shown in dark mode) -->
            <span v-if="isDark" class="i-lucide-sun w-3.5 h-3.5" aria-hidden="true" />
            <!-- Moon icon (shown in light mode) -->
            <span v-else class="i-lucide-moon w-3.5 h-3.5" aria-hidden="true" />
            <span v-if="mobile.enabled.value">{{ isDark ? t('Light theme') : t('Dark theme') }}</span>
          </button>
      </Teleport>
    </template>
    <div class="app-shell" :inert="mobile.enabled.value && mobile.menuOpen.value">

    <main class="app-main">
      <IoHost :bridge="ioBridge" @open-conversation="router.push(projectChatLocation($event))" />
      <div v-if="['spans', 'logs'].includes(String(route.name))" class="resource-scope" :aria-label="t('Project scope')">
        {{ t('Project') }}
        <router-link :to="{ name: 'project-settings', params: { projectId: route.params.projectId, section: 'general' } }">{{ route.params.projectId }}</router-link>
      </div>
      <ConnectionStatus :child-title="showChildRecovery ? recoveryTitle : undefined" :live-error="liveError"
        :notification-error="monitoringError || sounds.error.value"
        @retry="livePool.retry()" @manage-node="router.push({ name: 'settings', params: { section: 'nodes' } })" />
      <div
        class="route-content"
        :class="{ 'chat-route': workspaceRoutes.includes(String(route.name)), 'settings-route': route.name === 'settings' }"
      >
      <router-view v-slot="{ Component, route: viewRoute }">
        <KeepAlive :key="resolvedBase" include="ProjectsWorkspace">
          <component
            :is="Component"
            :key="workspaceRoutes.includes(String(viewRoute.name)) ? 'projects-workspace' : `${String(viewRoute.name)}:${String(viewRoute.params.projectId ?? '')}`"
            v-bind="viewRoute.name === 'settings' ? providerViewProps : { apiBase: contentBase, projectId: viewRoute.params.projectId, hostApiBase: resolvedBase, visible: workspaceRoutes.includes(String(route.name)) }"
            v-on="viewRoute.name === 'settings' ? providerViewEvents : {}"
            @update:log-count="logCount = $event"
          />
        </KeepAlive>
      </router-view>
      </div>
    </main>
    </div>
  </DesktopFrame>
</template>

<script setup lang="ts">
import { t } from './i18n.ts'
import { installRevealBorder } from './reveal-border.ts'
import { computed, ref, onMounted, onUnmounted, watch, provide, inject } from 'vue'
import { browserSessionKey } from './web-auth.ts'
import { mobileSessionKey } from './mobile-client.ts'
import MobileConnection from './MobileConnection.vue'
import { useRoute, useRouter } from 'vue-router'
import { useInstallationContext } from './composables/useInstallationContext.ts'
import { useTheme } from './composables/useTheme'
import { navigationFor, type NavigationGroup } from './navigation-policy.ts'
import { provideProviderReadiness } from './provider-readiness.ts'
import { createProviderSetupClient, type ProviderSetupStatus } from './provider-setup.ts'
import DesktopFrame from './DesktopFrame.vue'
import MobileChrome from './components/MobileChrome.vue'
import { provideMobileChrome } from './composables/useMobileChrome.ts'
import DesktopBrowserAccess from './components/DesktopBrowserAccess.vue'
import ConnectionStatus from './components/ConnectionStatus.vue'
import IoHost from './components/io/IoHost.vue'
import { createIoBridge, ioBridgeKey } from './io/bridge.ts'
import { projectChatLocation } from './projects.ts'
import { projectBase } from './api-url.ts'
import { watchFrontendLogScope } from './frontend-log-scope.ts'
import { useLiveClientPool } from './composables/useLiveClient.ts'
import type { LiveStatus } from './live-client.ts'
import { useAppNotificationSounds } from './composables/useAppNotificationSounds.ts'

const route = useRoute()
const workspaceRoutes: readonly string[] = ['chat', 'projects', 'project-settings', 'agents']
const mobile = provideMobileChrome()
const mobilePageTitles: Record<string, string> = { get chat() { return t('Chat') }, get projects() { return t('Projects') }, get nodes() { return t('Nodes') }, get settings() { return t('Settings') }, get 'project-settings'() { return t('Project settings') }, get agents() { return t('Agents') }, get spans() { return t('Spans') }, get logs() { return t('Logs') } }
const mobilePageTitle = computed(() => mobilePageTitles[String(route.name)] ?? 'Shadow')
watch(() => route.fullPath, () => { mobile.menuOpen.value = false })
const ioBridge = createIoBridge()
provide(ioBridgeKey, ioBridge)
const router = useRouter()
const lastChatLocation = ref('/chat')
watch(() => route.fullPath, (path) => {
  if (route.name === 'chat') lastChatLocation.value = path
}, { immediate: true })
const { isDark, toggleTheme } = useTheme()
const installationContext = useInstallationContext()
const { sounds, monitoringError, toggle: toggleSounds, browserNotifications } = useAppNotificationSounds(() => ({
  base: installationContext.value.apiBase, allowed: true,
}))
const livePool = useLiveClientPool()
const liveStatuses = ref<readonly LiveStatus[]>([])
const browserSession = inject(browserSessionKey, null)
const mobileSession = inject(mobileSessionKey, null)
const desktopWebPairing = window.shadowDesktop?.webPairing
let liveInterrupted = false
const stopLiveStatus = livePool.observe(statuses => {
  liveStatuses.value = statuses
  const interrupted = statuses.some(status => status.phase === 'error' || status.phase === 'reconnecting')
  if (interrupted && !liveInterrupted) void browserSession?.refresh()
  liveInterrupted = interrupted
})
const liveError = computed(() => liveStatuses.value.find(status => status.error)?.error ?? '')

const resolvedBase = computed(() => installationContext.value.apiBase)
// Dev diagnostics follow only an explicit visible Project; never infer ownership
// from a log payload or silently attribute host/unscoped logs to a default Project.
if (import.meta.env.DEV) {
  const stopWatch = watchFrontendLogScope(() => typeof route.params.projectId === 'string'
    ? projectBase(resolvedBase.value, route.params.projectId) : undefined)
  onUnmounted(stopWatch)
  if (import.meta.hot) import.meta.hot.dispose(stopWatch)
}
const contentBase = computed(() => typeof route.params.projectId === 'string' && !workspaceRoutes.includes(String(route.name))
  ? projectBase(resolvedBase.value, route.params.projectId) : resolvedBase.value)
const showChildRecovery = computed(() =>
  installationContext.value.mode === 'child' && !installationContext.value.mainWorkspace &&
  installationContext.value.mainConnection !== 'connected'
)
const recoveryTitle = computed(() =>
  installationContext.value.mainConnection === 'connecting'
    ? t('Reconnecting to Main')
    : t('Main is unavailable')
)

const logCount = ref(0)

// ── Model selector ──────────────────────────────────────────
const isMain = computed(() => installationContext.value.mainWorkspace === true || installationContext.value.mode === 'main' || installationContext.value.mode === 'client' || installationContext.value.mainConnection === 'connected')
const providerStatus = ref<ProviderSetupStatus | null>(null)
const checkingProvider = ref(true)
const providerError = ref('')
provideProviderReadiness({ status: providerStatus, checking: checkingProvider, error: providerError, enabled: isMain,
  canConfigure: isMain,
  retry: () => { void refreshProvider(true) },
})
const providerViewProps = computed(() => ({
  apiBase: resolvedBase.value,
  status: providerStatus.value,
  error: providerError.value,
  checking: checkingProvider.value,
  available: isMain.value,
}))
const providerViewEvents = {
  configured: providerConfigured,
  retry: () => { void refreshProvider(true) },
  close: () => { void router.push(lastChatLocation.value) },
}
let providerGeneration = 0
let providerRequest: AbortController | undefined
async function refreshProvider(refresh = false) {
  const generation = ++providerGeneration
  providerRequest?.abort()
  providerRequest = new AbortController()
  const signal = providerRequest.signal
  if (!refresh) providerStatus.value = null
  checkingProvider.value = isMain.value
  providerError.value = ''
  if (!isMain.value) return
  try {
    const status = await createProviderSetupClient(resolvedBase.value).status(signal, refresh)
    if (generation !== providerGeneration) return
    providerStatus.value = status
  } catch (error) {
    if (signal.aborted || generation !== providerGeneration) return
    providerError.value = error instanceof Error ? error.message : t('Could not check provider configuration. Retry when Main is available.')
  } finally {
    if (generation === providerGeneration) checkingProvider.value = false
  }
}

function providerConfigured() {
  window.dispatchEvent(new CustomEvent('shadow:config-changed'))
  void router.push(lastChatLocation.value)
}

watch(resolvedBase, () => { void refreshProvider() })
const onConfigChanged = (event: Event) => {
  if (!(event as CustomEvent<{ projectId?: string }>).detail?.projectId) {
    // Configuration may change the primary provider; old identity is no longer safe.
    providerStatus.value = null
    void refreshProvider(true)
  }
}

const navigationGroups = computed(() => {
  const items = navigationFor(installationContext.value)
  const groups: Array<{
    name: NavigationGroup
    label: string
    items: typeof items
  }> = [
    {
      name: 'primary',
      label: '',
      items: items.filter((item) => item.group === 'primary'),
    },
    {
      name: 'diagnostics',
      label: t('Diagnostics'),
      items: items.filter((item) => item.group === 'diagnostics'),
    },
  ]

  return groups.filter((group) => group.items.length > 0)
})

let stopRevealBorder: (() => void) | undefined
onMounted(() => {
  stopRevealBorder = installRevealBorder()
  window.addEventListener('shadow:config-changed', onConfigChanged)
  void refreshProvider()
})

onUnmounted(() => {
  stopRevealBorder?.()
  stopLiveStatus()
  window.removeEventListener('shadow:config-changed', onConfigChanged)
  ++providerGeneration
  providerRequest?.abort()
})
</script>

<style scoped>
/* ── App shell ─────────────────────────────────────────────── */

.app-shell {
  height: 100%;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.provider-error { flex: 0 0 auto; color: var(--c-error); padding: 8px 12px; margin: 0; }
.resource-scope { display: flex; align-items: center; gap: 8px; padding: 8px 16px; border-bottom: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 12px; overflow-wrap: anywhere; }
.resource-scope a { color: var(--c-text); }

.app-main {
  position: relative;
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.route-content { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 16px; }
.route-content.chat-route { display: flex; padding: 0; overflow: hidden; }
.route-content.settings-route { scrollbar-gutter: stable; }
.setup-content-scroll { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 16px; }

.tab-nav {
  display: flex;
  align-items: center;
  gap: 0;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: none;
}

.tab-nav::-webkit-scrollbar {
  display: none;
}

.tab-group-label {
  align-self: stretch;
  display: flex;
  align-items: center;
  margin-left: 0.35rem;
  padding-left: 0.65rem;
  border-left: 1px solid var(--c-border);
  font-size: 0.5rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
  white-space: nowrap;
}

.tab {
  flex-shrink: 0;
  border: none;
  background: transparent;
  padding: 0.5rem 0.6rem;
  font-size: 0.65rem;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-text-muted);
  cursor: pointer;
  white-space: nowrap;
  border-bottom: 2px solid transparent;
  transition: color 0.15s ease, border-color 0.15s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.tab:hover {
  color: var(--c-text-secondary);
  transform: translateY(-1px);
}

.tab:active {
  transform: translateY(0);
}

.tab.active {
  color: var(--c-primary);
  border-bottom-color: var(--c-blue);
}
.tab-nav.mobile-app-nav { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 4px; overflow: visible; }
.mobile-app-nav .tab { min-height: 44px; padding: 8px; font-size: 13px; text-transform: none; letter-spacing: 0; border: 0; text-align: left; transform: none; transition: none; }
.mobile-app-nav .tab.active { background: var(--c-selection-bg); }
.mobile-app-nav .tab:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.mobile-app-nav .tab-group-label { display: none; }

@media (max-width: 760px) {
  @media (max-width: 1100px) { .tab-group-label { display: none; } .tab { padding-inline: 7px; font-size: 10px; } }

}

.theme-toggle {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: transparent;
  color: var(--c-text-muted);
  cursor: pointer;
  transition: color 0.15s ease, border-color 0.15s ease, transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.theme-toggle:hover {
  color: var(--c-text);
  border-color: var(--c-border-hover);
  transform: translateY(-1px) scale(1.05);
}

.theme-toggle:active {
  transform: translateY(0) scale(0.95);
}
@media (max-width: 700px) {
  .mobile-global-actions .theme-toggle, .mobile-global-actions .tab { width: auto; min-height: 44px; height: auto; gap: 8px; padding: 8px 12px; font-size: 13px; transform: none; }
}

.system-bar-api {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.system-bar-api-label {
  font-size: 0.55rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
}

.system-bar-api-input {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg-soft);
  padding: 0.15rem 0.4rem;
  font-size: 0.65rem;
  width: 10rem;
  color: var(--c-text-secondary);
}

.system-bar-api-input:focus {
  outline: none;
  border-color: var(--c-border-hover);
}

/* ── Shared utility classes ──────────────────────────────── */

.input {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  background: var(--c-bg-input);
}

.tag {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-sm);
  padding: 0.1rem 0.4rem;
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  background: var(--c-bg-soft);
  color: var(--c-text-body);
}

.tag.active {
  background: var(--c-primary-bg);
  color: var(--c-text-on-primary);
  border-color: var(--c-primary-bg);
}

.tag.small {
  font-size: 0.6rem;
  padding: 0.05rem 0.3rem;
}

.log-panel {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.75rem;
  max-height: 320px;
  overflow: auto;
  background: var(--c-bg-code);
  color: var(--c-text-on-dark);
  font-size: 0.7rem;
  line-height: 1.5;
}

.detail-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.75rem;
  background: var(--c-bg-card);
  display: grid;
  gap: 0.6rem;
}

.detail-row {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.8rem;
  color: var(--c-text-body);
}

.detail-row strong {
  color: var(--c-text);
}

.detail-json {
  background: var(--c-bg-code);
  color: var(--c-text-on-dark);
  border-radius: var(--radius-surface);
  padding: 0.6rem;
  font-size: 0.7rem;
  line-height: 1.5;
  overflow: auto;
  max-height: 280px;
}

.trace-stack {
  display: grid;
  gap: 0.5rem;
  margin-bottom: 0.25rem;
}

.trace-section {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.6rem;
  background: var(--c-bg-card);
  display: grid;
  gap: 0.5rem;
}

.trace-title {
  font-size: 0.65rem;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--c-text-muted);
  font-weight: 600;
}

.log-line+.log-line {
  margin-top: 0.25rem;
}

.prompt-preview {
  display: grid;
  gap: 0.5rem;
}

.prompt-card {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.6rem 0.75rem;
  background: var(--c-bg-card);
}

.prompt-header {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
}

.prompt-header .role {
  font-weight: 600;
  color: var(--c-text-secondary);
}

.prompt-header .name {
  font-weight: 500;
  text-transform: none;
  letter-spacing: 0.02em;
}

.content {
  margin-top: 0.4rem;
  white-space: pre-wrap;
}

.tool-calls {
  margin-top: 0.4rem;
  padding: 0.5rem;
  border-radius: var(--radius-surface);
  background: var(--c-bg-muted);
}

.tool-call+.tool-call {
  margin-top: 0.4rem;
}

.stat {
  border: 1px solid var(--c-border);
  border-radius: var(--radius-surface);
  padding: 0.75rem;
  background: var(--c-bg-card);
}

.stat p {
  margin: 0;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  font-size: 0.6rem;
  color: var(--c-text-muted);
}

.stat h3 {
  margin: 0.3rem 0 0;
  font-size: 1.5rem;
}

.stats-compact {
  padding: 0.75rem;
}

.stats-compact h2 {
  font-size: 1.2rem;
}

.stats-compact .stat {
  padding: 0.5rem;
}

.stats-compact .stat h3 {
  font-size: 1.1rem;
}

@media (max-width: 768px) {
  .prompt-header {
    flex-wrap: wrap;
  }
}
</style>
