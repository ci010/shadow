<template>
  <section class="product-page fade-in">
    <header class="page-header">
      <div class="min-w-0">
        <component :is="embedded ? 'h2' : 'h1'" ref="heading" tabindex="-1">{{ t('Nodes') }}</component>
        <p class="page-summary">{{ t('Devices and the capabilities they provide.') }}</p>
      </div>
      <div class="context-strip" :aria-label="t('Administration access')">
        <span class="role-mark">{{ context.mode === 'main' ? t('Main') : t('Child') }}</span>
        <span>{{ canAdministerDevices(context) ? t('Device administration') : t('Read only') }}</span>
        <button type="button" class="inventory-refresh" :disabled="loading" @click="refresh">{{ loading ? t('Refreshing…') : error ? t('Retry') : t('Refresh') }}</button>
      </div>
    </header>

    <DesktopRoleSettings />

    <DeviceAdministration v-if="canAdministerDevices(context)" :api-base="apiBase" :nodes="nodes" @changed="refresh" />

    <p v-if="error" class="inventory-error" role="alert">{{ error }}</p>
    <p v-else-if="loading && !loaded" class="inventory-status" role="status">{{ t('Loading devices…') }}</p>
    <p v-else-if="loaded" class="inventory-status">
      {{ context.mode === 'child' ? t('Capabilities provided by this Child.') : t('Main and registered Child devices.') }}
      {{ t('Updated') }} {{ updatedAt }}{{ t('. Refreshes automatically while visible.') }}
    </p>

    <section v-if="removingNode" class="node-removal" aria-labelledby="node-removal-title">
      <h2 id="node-removal-title" ref="removalHeading" tabindex="-1">{{ t('Remove') }} {{ removingNode.displayName }}?</h2>
      <p>{{ t('This revokes trust and disconnects the device. Existing credentials will no longer reconnect; running remote tasks may be interrupted.') }}</p>
      <p>{{ t('Conversation history and files on Child are kept. Removing a device does not guarantee that commands already started on it have stopped.') }}</p>
      <p v-if="removalError" class="inventory-error" role="alert">{{ removalError }}</p>
      <div class="node-removal-actions">
        <button type="button" class="inventory-refresh" :disabled="removing" @click="cancelRemoval">{{ t('Cancel') }}</button>
        <button type="button" class="inventory-refresh remove-confirm" :disabled="removing" @click="removeDevice">{{ removing ? t('Removing…') : t('Remove device') }}</button>
      </div>
    </section>
    <p v-if="removalStatus" class="inventory-status" role="status">{{ removalStatus }}</p>
    <p v-if="loaded && !error && !activeNodes.length" class="empty-panel">{{ t('No active devices registered.') }}</p>
    <div class="node-admin-list" :aria-busy="loading">
      <article v-for="node in activeNodes" :key="node.nodeId" class="node-admin-row">
        <div class="node-admin-primary">
          <span class="status-dot large" :class="node.connection" />
          <div class="min-w-0">
            <div class="node-title-line">
              <h2>{{ node.displayName }}</h2>
              <span class="role-mark">{{ node.role === 'main' ? t('Main') : t('Child') }}</span>
              <span v-if="node.nodeId === context.localNodeId" class="local-mark">{{ t('This machine') }}</span>
            </div>
            <p class="mono break-value">{{ node.nodeId }}</p>
          </div>
        </div>

        <dl class="node-facts">
          <div><dt>{{ t('Connection') }}</dt><dd>{{ connectionLabel(node.connection) }}</dd></div>
          <div v-if="node.implementationVersion"><dt>{{ t('Version') }}</dt><dd class="mono">{{ node.implementationVersion }}</dd></div>
          <div v-if="node.lastSeen"><dt>{{ t('Last seen') }}</dt><dd>{{ formatDateTime(new Date(node.lastSeen)) }}</dd></div>
        </dl>

        <details v-if="node.capabilities.length" class="node-capabilities">
          <summary>
            <span>{{ t('Capabilities') }}</span>
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
        <p v-else class="node-capabilities-empty">{{ t('No capabilities advertised.') }}</p>
        <div v-if="canAdministerDevices(context) && node.role === 'child' && node.nodeId !== context.localNodeId" class="node-removal-actions">
          <button type="button" class="inventory-refresh" :disabled="!!removingNode || !!error" :aria-label="t('Remove {displayName}', { displayName: node.displayName })" @click="confirmRemoval(node)">{{ t('Remove device…') }}</button>
        </div>
      </article>
    </div>
    <details v-if="removedNodes.length" class="removed-devices">
      <summary>{{ t('Removed devices (') }}{{ removedNodes.length }})</summary>
      <p>{{ t('Trust revoked. Old credentials cannot reconnect. History and Child files are retained.') }}</p>
      <ul>
        <li v-for="node in removedNodes" :key="node.nodeId">
          <strong>{{ node.displayName }}</strong>
          <span>{{ t('Removed') }}</span>
          <code class="break-value">{{ node.nodeId }}</code>
        </li>
      </ul>
    </details>
  </section>
</template>

<script setup lang="ts">
import { t, formatDateTime } from '../i18n.ts'
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { CAPABILITY_LABELS, capabilityAvailability, capabilitySummary, fetchNodeInventory, type NodeInventoryEntry } from '../node-inventory.ts'
import DesktopRoleSettings from './DesktopRoleSettings.vue'
import DeviceAdministration from './DeviceAdministration.vue'
import { canAdministerDevices, revokeDevice } from './device-administration.ts'

const props = defineProps<{ apiBase: string; embedded?: boolean }>()
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
    removalStatus.value = t('{displayName} removed. History and Child files were kept.', { displayName: node.displayName })
    cancelRemoval()
  } catch (cause) {
    if (removalController === current) removalError.value = t('{value1} Main may have received the request; retry to confirm removal.', { value1: cause instanceof Error ? cause.message : t('Device removal failed.') })
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
    updatedAt.value = formatDateTime(new Date(), { hour: 'numeric', minute: '2-digit', second: '2-digit' })
  } catch (cause) {
    if (controller !== current) return
    nodes.value = []
    loaded.value = false
    error.value = cause instanceof Error && cause.message !== 'Failed to fetch' && cause.name !== 'TimeoutError'
      ? cause.message : t('Cannot reach the device inventory. Check the backend connection and retry.')
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
  if (connection === 'offline') return t('Offline')
  if (connection === 'revoked') return t('Revoked')
  return t('Connected')
}

function availabilityLabel(availability: ReturnType<typeof capabilityAvailability>): string {
  if (availability === 'online') return t('Online')
  if (availability === 'revoked') return t('Revoked')
  return t('Unavailable')
}
</script>

<style scoped src="../product-views.css"></style>