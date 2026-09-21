<template>
  <section class="product-page fade-in">
    <header class="page-header">
      <div class="min-w-0">
        <h1 ref="heading" tabindex="-1">Nodes</h1>
        <p class="page-summary">Devices and the capabilities they provide.</p>
      </div>
      <div class="context-strip" aria-label="Administration access">
        <span class="role-mark">{{ context.mode === 'main' ? 'Main' : 'Child' }}</span>
        <span>{{ canAdministerDevices(context) ? 'Device administration' : 'Read only' }}</span>
        <button type="button" class="inventory-refresh" :disabled="loading" @click="refresh">{{ loading ? 'Refreshing…' : error ? 'Retry' : 'Refresh' }}</button>
      </div>
    </header>

    <DeviceAdministration v-if="canAdministerDevices(context)" :api-base="apiBase" :nodes="nodes" @changed="refresh" />

    <p v-if="error" class="inventory-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !loaded" class="inventory-status" role="status">Loading devices…</p>
    <p v-else-if="loaded" class="inventory-status">
      {{ context.mode === 'child' ? 'Capabilities provided by this Child.' : 'Main and registered Child devices.' }}
      Updated {{ updatedAt }}. Refreshes automatically while visible.
    </p>

    <section v-if="removingNode" class="node-removal" aria-labelledby="node-removal-title">
      <h2 id="node-removal-title" ref="removalHeading" tabindex="-1">Remove {{ removingNode.displayName }}?</h2>
      <p>This revokes trust and disconnects the device. Existing credentials will no longer reconnect; running remote tasks may be interrupted.</p>
      <p>Conversation history and files on Child are kept. Removing a device does not guarantee that commands already started on it have stopped.</p>
      <p v-if="removalError" class="inventory-error" role="alert">{{ removalError }}</p>
      <div class="node-removal-actions">
        <button type="button" class="inventory-refresh" :disabled="removing" @click="cancelRemoval">Cancel</button>
        <button type="button" class="inventory-refresh remove-confirm" :disabled="removing" @click="removeDevice">{{ removing ? 'Removing…' : 'Remove device' }}</button>
      </div>
    </section>
    <p v-if="removalStatus" class="inventory-status" role="status">{{ removalStatus }}</p>
    <p v-if="loaded && !error && !activeNodes.length" class="empty-panel">No active devices registered.</p>
    <div class="node-admin-list" :aria-busy="loading">
      <article v-for="node in activeNodes" :key="node.nodeId" class="node-admin-row">
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
        <div v-if="canAdministerDevices(context) && node.role === 'child' && node.nodeId !== context.localNodeId" class="node-removal-actions">
          <button type="button" class="inventory-refresh" :disabled="!!removingNode || !!error" :aria-label="`Remove ${node.displayName}`" @click="confirmRemoval(node)">Remove device…</button>
        </div>
      </article>
    </div>
    <details v-if="removedNodes.length" class="removed-devices">
      <summary>Removed devices ({{ removedNodes.length }})</summary>
      <p>Trust revoked. Old credentials cannot reconnect. History and Child files are retained.</p>
      <ul>
        <li v-for="node in removedNodes" :key="node.nodeId">
          <strong>{{ node.displayName }}</strong>
          <span>Removed</span>
          <code class="break-value">{{ node.nodeId }}</code>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { CAPABILITY_LABELS, capabilityAvailability, capabilitySummary, fetchNodeInventory, type NodeInventoryEntry } from '../node-inventory.ts'
import DeviceAdministration from './DeviceAdministration.vue'
import { canAdministerDevices, revokeDevice } from './device-administration.ts'

const props = defineProps<{ apiBase: string }>()
const context = useInstallationContext()
const nodes = ref<readonly NodeInventoryEntry[]>([])
const activeNodes = computed(() => nodes.value.filter(node => node.connection !== 'revoked'))
const removedNodes = computed(() => nodes.value.filter(node => node.connection === 'revoked'))
const removingNode = ref<NodeInventoryEntry>()
const removing = ref(false)
const removalError = ref('')
const removalStatus = ref('')
const heading = ref<HTMLElement>()
const removalHeading = ref<HTMLElement>()
let removalController: AbortController | undefined
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const updatedAt = ref('')
let controller: AbortController | undefined
let timer: ReturnType<typeof setTimeout> | undefined
let mounted = false

async function confirmRemoval(node: NodeInventoryEntry) {
  removingNode.value = node
  removalError.value = ''
  removalStatus.value = ''
  await nextTick()
  removalHeading.value?.focus()
}

function cancelRemoval() {
  removingNode.value = undefined
  removalError.value = ''
  heading.value?.focus()
}

async function removeDevice() {
  const node = removingNode.value
  if (!node || removing.value || !canAdministerDevices(context.value)) return
  const current = new AbortController()
  removalController = current
  removing.value = true
  removalError.value = ''
  stop()
  try {
    await revokeDevice(props.apiBase, node.nodeId, AbortSignal.any([current.signal, AbortSignal.timeout(15_000)]))
    if (removalController !== current) return
    nodes.value = nodes.value.map(value => value.nodeId === node.nodeId ? { ...value, connection: 'revoked', capabilities: [] } : value)
    removalStatus.value = `${node.displayName} removed. History and Child files were kept.`
    cancelRemoval()
  } catch (cause) {
    if (removalController === current) removalError.value = `${cause instanceof Error ? cause.message : 'Device removal failed.'} Main may have received the request; retry to confirm removal.`
  } finally {
    if (removalController === current) {
      removalController = undefined
      removing.value = false
      void refresh()
    }
  }
}

function stop() {
  clearTimeout(timer)
  controller?.abort()
  controller = undefined
  loading.value = false
}

async function refresh() {
  stop()
  if (!mounted || document.hidden || removing.value) return
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
  removalController?.abort()
  removalController = undefined
  removing.value = false
  removingNode.value = undefined
  removalError.value = ''
  removalStatus.value = ''
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
  removalController?.abort()
  removalController = undefined
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