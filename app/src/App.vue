<template>
  <DesktopFrame>
    <template #navigation>
        <nav class="tab-nav" aria-label="Main navigation">
          <template v-for="group in navigationGroups" :key="group.name">
            <span v-if="group.label" class="tab-group-label">{{ group.label }}</span>
            <router-link v-for="item in group.items" :key="item.name" :to="item.name === 'chat' ? lastChatLocation : { name: item.name, params: ['agents', 'spans', 'logs'].includes(item.name) ? { organizationId: route.params.organizationId || 'default' } : {} }" custom v-slot="{ isActive, navigate }">
              <button class="tab" :class="{ active: isActive }" :aria-current="isActive ? 'page' : undefined" @click="navigate">
                {{ item.label }}
              </button>
            </router-link>
          </template>
        </nav>
    </template>
    <template #actions>
          <button class="theme-toggle" @click="toggleTheme" :title="isDark ? 'Switch to light' : 'Switch to dark'" :aria-label="isDark ? 'Switch to light theme' : 'Switch to dark theme'">
            <!-- Sun icon (shown in dark mode) -->
            <span v-if="isDark" class="i-lucide-sun w-3.5 h-3.5" aria-hidden="true" />
            <!-- Moon icon (shown in light mode) -->
            <span v-else class="i-lucide-moon w-3.5 h-3.5" aria-hidden="true" />
          </button>
    </template>
    <div class="app-shell">
    <div class="mouse-glow-layer" aria-hidden="true"><div ref="glowEl" class="mouse-glow" /></div>

    <div class="runtime-status-bar" aria-label="Runtime status">
      <div class="runtime-status-inner">
        <span class="runtime-status-item"><strong>Role</strong> {{ roleLabel }}</span>
        <span class="runtime-status-item">
          <span class="runtime-dot" :class="installationContext.mainConnection" />
          <strong>Main</strong> {{ mainConnectionLabel }}<template v-if="installationContext.mainLatencyMs !== null"> · {{ installationContext.mainLatencyMs }} ms</template>
        </span>
        <span class="runtime-status-item runtime-status-node" :title="installationContext.localNodeId">
          <strong>Local node</strong> {{ installationContext.localNodeId }}
        </span>
      </div>
    </div>

    <main class="app-main">
      <div v-if="['agents', 'spans', 'logs'].includes(String(route.name))" class="resource-scope" aria-label="Organization scope">
        Organization
        <router-link :to="{ name: 'organization-settings', params: { organizationId: route.params.organizationId, section: 'general' } }">{{ route.params.organizationId }}</router-link>
      </div>
      <aside v-if="showChildRecovery" class="recovery-panel" role="status">
        <div class="recovery-copy">
          <strong>{{ recoveryTitle }}</strong>
          <span>Main-backed tools may be stale, but this Child's local controls remain available.</span>
        </div>
        <div class="recovery-links">
          <router-link :to="{ name: 'nodes' }">Manage this node</router-link>
        </div>
      </aside>
      <div
        class="route-content"
        :class="{ 'chat-route': route.name === 'chat' || route.name === 'organizations' }"
      >
      <router-view v-slot="{ Component, route: viewRoute }">
        <KeepAlive :key="resolvedBase" include="OrganizationsWorkspace,OrganizationSettings">
          <component
            :is="Component"
            :key="viewRoute.name === 'chat' || viewRoute.name === 'organizations' ? 'organizations-workspace' : `${String(viewRoute.name)}:${String(viewRoute.params.organizationId ?? '')}`"
            v-bind="viewRoute.name === 'settings' ? providerViewProps : { apiBase: contentBase, organizationId: viewRoute.params.organizationId, hostApiBase: resolvedBase, visible: route.name === 'chat' || route.name === 'organizations' }"
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
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useInstallationContext } from './composables/useInstallationContext.ts'
import { useTheme } from './composables/useTheme'
import { navigationFor, type NavigationGroup } from './navigation-policy.ts'
import { createProviderSetupClient, type ProviderSetupStatus } from './provider-setup.ts'
import DesktopFrame from './DesktopFrame.vue'
import { organizationBase } from './api-url.ts'

const route = useRoute()
const router = useRouter()
const lastChatLocation = ref('/chat')
watch(() => route.fullPath, (path) => {
  if (route.name === 'chat') lastChatLocation.value = path
}, { immediate: true })
const { isDark, toggleTheme } = useTheme()
const installationContext = useInstallationContext()

const resolvedBase = computed(() => installationContext.value.apiBase)
const contentBase = computed(() => typeof route.params.organizationId === 'string' && route.name !== 'chat'
  ? organizationBase(resolvedBase.value, route.params.organizationId) : resolvedBase.value)
const roleLabel = computed(() => installationContext.value.mode === 'main' ? 'Main' : 'Child')
const mainConnectionLabel = computed(() => {
  if (installationContext.value.mainConnection === 'connected') return 'Connected'
  if (installationContext.value.mainConnection === 'connecting') return 'Reconnecting'
  if (installationContext.value.mainConnection === 'unpaired') return 'Unpaired'
  return 'Offline'
})
const showChildRecovery = computed(() =>
  installationContext.value.mode === 'child' &&
  installationContext.value.mainConnection !== 'connected'
)
const recoveryTitle = computed(() =>
  installationContext.value.mainConnection === 'connecting'
    ? 'Reconnecting to Main'
    : 'Main is unavailable'
)

const logCount = ref(0)

// ── Model selector ──────────────────────────────────────────
const isMain = computed(() => installationContext.value.mode === 'main')
const providerStatus = ref<ProviderSetupStatus | null>(null)
const checkingProvider = ref(true)
const providerError = ref('')
const providerViewProps = computed(() => ({
  apiBase: resolvedBase.value,
  status: providerStatus.value,
  error: providerError.value,
  checking: checkingProvider.value,
  available: isMain.value && installationContext.value.uiScopes.includes('main:admin'),
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
  checkingProvider.value = isMain.value
  providerError.value = ''
  if (!isMain.value) return
  try {
    const status = await createProviderSetupClient(resolvedBase.value).status(signal, refresh)
    if (generation !== providerGeneration) return
    providerStatus.value = status
  } catch (error) {
    if (signal.aborted || generation !== providerGeneration) return
    providerStatus.value = null
    providerError.value = error instanceof Error ? error.message : 'Could not check provider configuration. Retry when Main is available.'
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
  if (!(event as CustomEvent<{ organizationId?: string }>).detail?.organizationId) void refreshProvider(true)
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
      label: 'Diagnostics',
      items: items.filter((item) => item.group === 'diagnostics'),
    },
  ]

  return groups.filter((group) => group.items.length > 0)
})

// ── Mouse glow follower ──────────────────────────────────────
const glowEl = ref<HTMLDivElement>()
let rafId = 0
let mouseX = 0
let mouseY = 0
let curX = 0
let curY = 0

function onMouseMove(e: MouseEvent) {
  mouseX = e.clientX
  mouseY = e.clientY
}

function tick() {
  // Smooth lerp towards mouse position
  curX += (mouseX - curX) * 0.15
  curY += (mouseY - curY) * 0.15
  if (glowEl.value) {
    glowEl.value.style.transform = `translate(${curX}px, ${curY}px)`
  }
  rafId = requestAnimationFrame(tick)
}

onMounted(() => {
  window.addEventListener('mousemove', onMouseMove)
  rafId = requestAnimationFrame(tick)
  window.addEventListener('shadow:config-changed', onConfigChanged)
  void refreshProvider()
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  window.removeEventListener('shadow:config-changed', onConfigChanged)
  ++providerGeneration
  providerRequest?.abort()
  cancelAnimationFrame(rafId)
})
</script>

<style scoped>
/* ── Mouse glow ───────────────────────────────────────────── */

.mouse-glow-layer {
  position: fixed;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
  z-index: 9999;
  mix-blend-mode: difference;
}
.mouse-glow {
  position: absolute;
  top: -16px;
  left: -16px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #a0a0a0;
  pointer-events: none;
  will-change: transform;
}

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

/* ── System bar ────────────────────────────────────────────── */

.runtime-status-bar {
  flex: 0 0 auto;
  min-width: 0;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg-soft);
}

.runtime-status-inner {
  display: flex;
  align-items: center;
  min-width: 0;
  height: 30px;
  padding: 0 0.75rem;
  overflow-x: auto;
  scrollbar-width: none;
}

.runtime-status-inner::-webkit-scrollbar {
  display: none;
}

.runtime-status-item {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  padding: 0 0.65rem;
  border-left: 1px solid var(--c-border);
  color: var(--c-text-secondary);
  font-size: 0.64rem;
  line-height: 1.2;
  white-space: nowrap;
}

.runtime-status-item:first-child {
  padding-left: 0;
  border-left: 0;
}

.runtime-status-item strong {
  color: var(--c-text-muted);
  font-size: 0.56rem;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}

.runtime-status-node {
  max-width: min(28vw, 260px);
  overflow: hidden;
  text-overflow: ellipsis;
}

.runtime-status-link {
  color: var(--c-text-secondary);
  text-decoration: none;
}

.runtime-status-link:hover {
  color: var(--c-text);
}

.runtime-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: var(--radius-circle);
  background: var(--c-success);
}

.runtime-dot.connecting {
  background: var(--c-warn);
}

.runtime-dot.offline,
.runtime-dot.unpaired {
  background: var(--c-error);
}

.app-main {
  flex: 1;
  min-height: 0;
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.route-content { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 16px; }
.route-content.chat-route { display: flex; padding: 0; overflow: hidden; }
.setup-content-scroll { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 16px; }

.recovery-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  width: min(1180px, 100%);
  margin: 0 auto 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--c-warn);
  border-radius: var(--radius-overlay);
  background: var(--c-warn-bg);
  color: var(--c-text-secondary);
  font-size: 0.72rem;
}

.recovery-copy,
.recovery-links {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
}

.recovery-copy strong {
  flex: 0 0 auto;
  color: var(--c-warn);
}

.recovery-copy span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.recovery-links {
  flex: 0 0 auto;
}

.recovery-links a {
  color: var(--c-text);
  font-weight: 600;
  white-space: nowrap;
}

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
  color: var(--c-text);
  border-bottom-color: var(--c-text);
}

@media (max-width: 760px) {
  .runtime-status-node {
    max-width: 11rem;
  }
  @media (max-width: 1100px) { .tab-group-label { display: none; } .tab { padding-inline: 7px; font-size: 10px; } }

  .recovery-panel,
  .recovery-copy {
    align-items: flex-start;
    flex-direction: column;
  }

  .recovery-links {
    align-self: stretch;
    justify-content: space-between;
  }
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

.btn {
  border: 1px solid var(--c-border);
  background: var(--c-primary-bg);
  color: var(--c-text-on-primary);
  padding: 0.4rem 0.75rem;
  border-radius: var(--radius-control);
  font-size: 0.75rem;
  font-weight: 500;
  cursor: pointer;
  transition: transform 0.2s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.2s ease, background 0.15s ease;
}

.btn:hover {
  background: var(--c-primary-bg-hover);
  transform: translateY(-1px) scale(1.03);
  box-shadow: 0 4px 12px var(--c-shadow);
}

.btn:active {
  transform: translateY(0) scale(0.98);
  box-shadow: none;
  transition-duration: 0.08s;
}

.btn.ghost {
  background: transparent;
  color: var(--c-text);
}

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
