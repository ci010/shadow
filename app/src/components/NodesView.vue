<template>
  <section class="product-page fade-in">
    <header class="page-header">
      <div class="min-w-0">
        <h1>Nodes</h1>
        <p class="page-summary">Devices and the capabilities they provide.</p>
      </div>
      <div class="context-strip" aria-label="Administration access">
        <span class="role-mark">{{ context.mode === 'main' ? 'Main' : 'Child' }}</span>
        <span>Read only</span>
        <button type="button" class="inventory-refresh" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : error ? 'Retry' : 'Refresh' }}</button>
      </div>
    </header>

    <p v-if="error" class="inventory-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !loaded" class="inventory-status" role="status">Loading devices…</p>
    <p v-else-if="loaded" class="inventory-status">
      {{ context.mode === 'child' ? 'Capabilities provided by this Child.' : 'Main and registered Child devices.' }}
      Updated {{ updatedAt }}. Refreshes automatically while visible.
    </p>

    <p v-if="loaded && !error && !nodes.length" class="empty-panel">No devices registered.</p>
    <div class="node-admin-list" :aria-busy="loading">
      <article v-for="node in nodes" :key="node.nodeId" class="node-admin-row">
        <div class="node-admin-primary">
          <span class="status-dot large" :class="node.connection" />
          <div class="min-w-0">
            <div class="node-title-line">
              <h2>{{ node.displayName }}</h2>
              <span class="role-mark">{{ node.role === 'main' ? 'Main' : 'Child' }}</span>
              <span v-if="node.nodeId === context.localNodeId" class="local-mark">This machine</span>
            </div>
            <p class="mono break-value">{{ node.nodeId }}</p>
          </div>
        </div>

        <dl class="node-facts">
          <div><dt>Connection</dt><dd>{{ connectionLabel(node.connection) }}</dd></div>
          <div v-if="node.implementationVersion"><dt>Version</dt><dd class="mono">{{ node.implementationVersion }}</dd></div>
          <div v-if="node.lastSeen"><dt>Last seen</dt><dd>{{ new Date(node.lastSeen).toLocaleString() }}</dd></div>
        </dl>

        <details v-if="node.capabilities.length" class="node-capabilities">
          <summary>
            <span>Capabilities</span>
            <span class="capability-overview">{{ capabilitySummary(node.capabilities) }}</span>
          </summary>
          <ul class="capability-list">
            <li v-for="capability in node.capabilities" :key="capability.capabilityId" class="capability-row">
              <div class="capability-top">
                <div class="min-w-0">
                  <span class="capability-kind">{{ CAPABILITY_LABELS[capability.kind] }}</span>
                  <h3>{{ capability.displayName }}</h3>
                </div>
                <span class="availability" :class="capabilityAvailability(node, capability)">{{ availabilityLabel(capabilityAvailability(node, capability)) }}</span>
              </div>
              <p v-if="capability.displayPath" class="path mono">{{ capability.displayPath }}</p>
            </li>
          </ul>
        </details>
        <p v-else class="node-capabilities-empty">No capabilities advertised.</p>
      </article>
    </div>
  </section>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { CAPABILITY_LABELS, capabilityAvailability, capabilitySummary, fetchNodeInventory, type NodeInventoryEntry } from '../node-inventory.ts'

const props = defineProps<{ apiBase: string }>()
const context = useInstallationContext()
const nodes = ref<readonly NodeInventoryEntry[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const updatedAt = ref('')
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let mounted = false

function stop() {
  clearTimeout(timer)
  controller?.abort()
  controller = undefined
  loading.value = false
}

async function refresh() {
  stop()
  if (!mounted || document.hidden) return
  const current = new AbortController()
  controller = current
  loading.value = true
  try {
    const result = await fetchNodeInventory(props.apiBase, context.value.mode, AbortSignal.any([current.signal, AbortSignal.timeout(10_000)]))
    if (controller !== current) return
    nodes.value = result.nodes
    loaded.value = true
    error.value = ''
    updatedAt.value = new Date().toLocaleTimeString()
  } catch (cause) {
    if (controller !== current) return
    nodes.value = []
    loaded.value = false
    error.value = cause instanceof Error && cause.message !== 'Failed to fetch' && cause.name !== 'TimeoutError'
      ? cause.message : 'Cannot reach the device inventory. Check the backend connection and retry.'
  } finally {
    if (controller === current) {
      controller = undefined
      loading.value = false
      if (mounted && !document.hidden) timer = setTimeout(refresh, 5_000)
    }
  }
}

function visibilityChanged() {
  if (document.hidden) stop()
  else void refresh()
}

watch(() => [props.apiBase, context.value.mode], () => {
  nodes.value = []
  loaded.value = false
  error.value = ''
  void refresh()
})
onMounted(() => {
  mounted = true
  document.addEventListener('visibilitychange', visibilityChanged)
  void refresh()
})
onUnmounted(() => {
  mounted = false
  stop()
  document.removeEventListener('visibilitychange', visibilityChanged)
})

function connectionLabel(connection: NodeInventoryEntry['connection']): string {
  if (connection === 'offline') return 'Offline'
  if (connection === 'revoked') return 'Revoked'
  return 'Connected'
}

function availabilityLabel(availability: ReturnType<typeof capabilityAvailability>): string {
  if (availability === 'online') return 'Online'
  if (availability === 'revoked') return 'Revoked'
  return 'Unavailable'
}
</script>

<style scoped src="../product-views.css"></style>