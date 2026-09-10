<template>
  <div class="app-shell">
    <!-- Mouse glow follower -->
    <div ref="glowEl" class="mouse-glow" />

    <!-- System bar -->
    <div class="system-bar">
      <div class="system-bar-inner">
        <span class="system-bar-title">Context Lens</span>
        <nav class="tab-nav">
          <template v-for="group in navigationGroups" :key="group.name">
            <span v-if="group.label" class="tab-group-label">{{ group.label }}</span>
            <router-link v-for="item in group.items" :key="item.name" :to="{ name: item.name }" custom v-slot="{ isActive, navigate }">
              <button class="tab" :class="{ active: isActive }" @click="navigate">
                {{ item.label }}
              </button>
            </router-link>
          </template>
        </nav>
        <div class="system-bar-right">
          <div class="system-bar-model">
            <label class="system-bar-model-label">Model</label>
            <select v-model="currentModel" class="system-bar-model-select" @change="onModelChange">
              <option v-for="m in modelOptions" :key="m" :value="m">{{ m }}</option>
              <option v-if="currentModel && !modelOptions.includes(currentModel)" :value="currentModel">{{ currentModel }}</option>
            </select>
          </div>
          <div v-if="!copilotAuthed" class="copilot-auth">
            <button class="copilot-login-btn" :disabled="copilotLoginPending" @click="startCopilotLogin">
              {{ copilotLoginPending ? 'Waiting for authorization…' : 'Login Copilot' }}
            </button>
            <div v-if="copilotLoginInfo" class="copilot-login-info">
              Visit
              <a :href="copilotLoginInfo.verification_uri" target="_blank" rel="noopener">{{ copilotLoginInfo.verification_uri }}</a>
              and enter code <code>{{ copilotLoginInfo.user_code }}</code>
            </div>
          </div>
          <button class="theme-toggle" @click="toggleTheme" :title="isDark ? 'Switch to light' : 'Switch to dark'">
            <!-- Sun icon (shown in dark mode) -->
            <svg v-if="isDark" xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            <!-- Moon icon (shown in light mode) -->
            <svg v-else xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
        </div>
      </div>
    </div>

    <div class="runtime-status-bar" aria-label="Runtime status">
      <div class="runtime-status-inner">
        <span class="runtime-status-item"><strong>Role</strong> {{ roleLabel }}</span>
        <span class="runtime-status-item">
          <span class="runtime-dot" :class="installationContext.mainConnection" />
          <strong>Main</strong> {{ mainConnectionLabel }}<template v-if="installationContext.mainLatencyMs !== null"> · {{ installationContext.mainLatencyMs }} ms</template>
        </span>
        <span class="runtime-status-item runtime-status-node" :title="activeLocalNode?.nodeId">
          <strong>Local node</strong> {{ activeLocalNode?.displayName ?? installationContext.localNodeId }}
        </span>
        <router-link
          v-if="installationContext.mode === 'child'"
          class="runtime-status-item runtime-status-link"
          :to="{ name: 'approvals' }"
        >
          <strong>Approvals</strong> {{ pendingLocalApprovalCount }} pending
        </router-link>
        <span v-else class="runtime-status-item"><strong>Approvals</strong> {{ pendingLocalApprovalCount }} pending</span>
      </div>
    </div>

    <main class="px-3 md:px-6 pb-6 mx-auto w-full app-main">
      <aside v-if="showChildRecovery" class="recovery-panel" role="status">
        <div class="recovery-copy">
          <strong>{{ recoveryTitle }}</strong>
          <span>Main-backed tools may be stale, but this Child's local controls remain available.</span>
        </div>
        <div class="recovery-links">
          <router-link :to="{ name: 'nodes' }">Manage this node</router-link>
          <router-link :to="{ name: 'approvals' }">Review approvals</router-link>
        </div>
      </aside>
      <router-view
        :api-base="resolvedBase"
        class="mt-4"
        @update:log-count="logCount = $event"
      />
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted, onUnmounted, watch } from 'vue'
import { useInstallationContext } from './composables/useInstallationContext.ts'
import { useProductFixtures } from './composables/useProductFixtures.ts'
import { useTheme } from './composables/useTheme'
import { navigationFor, type NavigationGroup } from './navigation-policy.ts'

const { isDark, toggleTheme } = useTheme()
const installationContext = useInstallationContext()
const productFixtures = useProductFixtures()

const resolvedBase = computed(() => installationContext.value.apiBase)
const activeLocalNode = computed(() => productFixtures.value.nodes.find((node) =>
  node.nodeId === installationContext.value.localNodeId
))
const pendingLocalApprovalCount = computed(() => productFixtures.value.approvals.filter((approval) =>
  approval.ownerNodeId === installationContext.value.localNodeId && approval.status === 'pending'
).length)
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
const currentModel = ref('')
const configCache = ref<Record<string, unknown> | null>(null)
const modelOptions = ref<string[]>([])

async function fetchModels() {
  try {
    const res = await fetch(`${resolvedBase.value}/debug/models`)
    if (!res.ok) return
    const data = await res.json()
    modelOptions.value = Array.isArray(data.models) ? data.models : []
  } catch { /* ignore */ }
}

// ── Copilot device-code authentication ──────────────────────
const copilotConfigured = ref(false)
const copilotAuthed = ref(true)
const copilotLoginPending = ref(false)
const copilotLoginInfo = ref<{ verification_uri: string; user_code: string; device_code: string } | null>(null)

async function checkCopilotAuth() {
  try {
    const res = await fetch(`${resolvedBase.value}/api/auth`)
    if (!res.ok) return
    const data = await res.json()
    copilotAuthed.value = !!data.authenticated && !!data.apiKeyValid
  } catch { /* ignore */ }
}

async function startCopilotLogin() {
  copilotLoginPending.value = true
  copilotLoginInfo.value = null
  try {
    const res = await fetch(`${resolvedBase.value}/api/auth/login`, { method: 'POST' })
    const data = await res.json()
    if (data.authenticated) {
      copilotAuthed.value = true
      return
    }
    if (!data.device_code) return
    copilotLoginInfo.value = {
      verification_uri: data.verification_uri,
      user_code: data.user_code,
      device_code: data.device_code,
    }
    // Open GitHub's device-authorization page for convenience.
    window.open(data.verification_uri, '_blank', 'noopener')
    // Poll until the user finishes authorizing (blocks server-side up to ~5min).
    const pollRes = await fetch(`${resolvedBase.value}/api/auth/poll`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: data.device_code }),
    })
    const pollData = await pollRes.json()
    if (pollData.authenticated) {
      copilotAuthed.value = true
      copilotLoginInfo.value = null
      fetchModels()
    }
  } catch { /* ignore */ } finally {
    copilotLoginPending.value = false
  }
}

async function fetchConfig() {
  try {
    const res = await fetch(`${resolvedBase.value}/api/config`)
    if (!res.ok) return
    const data = await res.json()
    configCache.value = data
    currentModel.value = data.agent?.model ?? ''
    // Detect whether Copilot is referenced anywhere in the config so we only
    // surface the login button for users who actually use it.
    copilotConfigured.value = JSON.stringify(data).toLowerCase().includes('copilot')
  } catch { /* ignore */ }
}

async function onModelChange() {
  if (!currentModel.value || !configCache.value) return
  try {
    const updated = { ...configCache.value, agent: { ...(configCache.value.agent as Record<string, unknown> ?? {}), model: currentModel.value } }
    const res = await fetch(`${resolvedBase.value}/api/config`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    })
    if (res.ok) {
      configCache.value = await res.json()
      // Notify other views (e.g. ChatTab's config badge) that the global
      // model/config changed so they can refresh.
      window.dispatchEvent(new CustomEvent('shadow:config-changed'))
    }
  } catch { /* ignore */ }
}

watch(resolvedBase, () => {
  fetchConfig()
  fetchModels()
  checkCopilotAuth()
}, { immediate: false })

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
  fetchConfig()
  fetchModels()
  checkCopilotAuth()
})

onUnmounted(() => {
  window.removeEventListener('mousemove', onMouseMove)
  cancelAnimationFrame(rafId)
})
</script>

<style scoped>
/* ── Mouse glow ───────────────────────────────────────────── */

.mouse-glow {
  position: fixed;
  top: -16px;
  left: -16px;
  width: 32px;
  height: 32px;
  border-radius: 50%;
  background: #a0a0a0;
  pointer-events: none;
  z-index: 9999;
  will-change: transform;
  mix-blend-mode: difference;
}

/* ── App shell ─────────────────────────────────────────────── */

.app-shell {
  display: flex;
  flex-direction: column;
}

/* ── System bar ────────────────────────────────────────────── */

.system-bar {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 50;
  background: var(--c-bg-card);
  border-bottom: 1px solid var(--c-border);
}

.runtime-status-bar {
  position: fixed;
  top: 36px;
  left: 0;
  right: 0;
  z-index: 49;
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
  border-radius: 50%;
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
  padding-top: 78px;
}

.recovery-panel {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  width: min(1180px, 100%);
  margin: 0 auto 0.75rem;
  padding: 0.65rem 0.75rem;
  border: 1px solid var(--c-warn);
  border-radius: 5px;
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

.system-bar-inner {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0 0.75rem;
  height: 36px;
}

.system-bar-title {
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: var(--c-text-muted);
  white-space: nowrap;
  flex-shrink: 0;
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

.system-bar-right {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-left: auto;
  flex-shrink: 0;
}

@media (max-width: 760px) {
  .system-bar-title,
  .system-bar-model-label {
    display: none;
  }

  .system-bar-inner {
    gap: 0.35rem;
  }

  .system-bar-model-select {
    width: 7rem;
  }

  .runtime-status-node {
    max-width: 11rem;
  }

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
  border-radius: 4px;
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
  border-radius: 4px;
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

.system-bar-model {
  display: flex;
  align-items: center;
  gap: 0.3rem;
}

.system-bar-model-label {
  font-size: 0.55rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--c-text-muted);
}

.system-bar-model-select {
  border: 1px solid var(--c-border);
  border-radius: 4px;
  background: var(--c-bg-soft);
  padding: 0.15rem 0.4rem;
  font-size: 0.65rem;
  color: var(--c-text-secondary);
  cursor: pointer;
  max-width: 12rem;
}

.system-bar-model-select:focus {
  outline: none;
  border-color: var(--c-border-hover);
}

/* ── Copilot auth ────────────────────────────────────────── */

.copilot-auth {
  position: relative;
  display: flex;
  align-items: center;
}

.copilot-login-btn {
  border: 1px solid var(--c-warning, #f59e0b);
  border-radius: 4px;
  background: var(--c-warning-bg, rgba(245, 158, 11, 0.12));
  color: var(--c-warning, #f59e0b);
  padding: 0.15rem 0.5rem;
  font-size: 0.6rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  cursor: pointer;
  white-space: nowrap;
}

.copilot-login-btn:hover:not(:disabled) {
  background: var(--c-warning, #f59e0b);
  color: #fff;
}

.copilot-login-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.copilot-login-info {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  width: max-content;
  max-width: 20rem;
  padding: 0.4rem 0.6rem;
  border: 1px solid var(--c-border);
  border-radius: 6px;
  background: var(--c-bg-soft);
  color: var(--c-text-secondary);
  font-size: 0.65rem;
  line-height: 1.4;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
}

.copilot-login-info code {
  font-weight: 700;
  color: var(--c-text-body);
  background: var(--c-bg-muted);
  padding: 0.05em 0.3em;
  border-radius: 3px;
}

/* ── Shared utility classes ──────────────────────────────── */

.btn {
  border: 1px solid var(--c-border);
  background: var(--c-primary-bg);
  color: var(--c-text-on-primary);
  padding: 0.4rem 0.75rem;
  border-radius: 4px;
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
  border-radius: 4px;
  padding: 0.4rem 0.6rem;
  font-size: 0.8rem;
  background: var(--c-bg-input);
}

.tag {
  border: 1px solid var(--c-border);
  border-radius: 3px;
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
  border-radius: 4px;
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
  border-radius: 6px;
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
  border-radius: 4px;
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
  border-radius: 6px;
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
  border-radius: 6px;
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
  border-radius: 4px;
  background: var(--c-bg-muted);
}

.tool-call+.tool-call {
  margin-top: 0.4rem;
}

.stat {
  border: 1px solid var(--c-border);
  border-radius: 6px;
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
