<template>
  <section class="device-administration" aria-labelledby="device-pairing-title">
    <header class="device-section-header">
      <div>
        <h2 id="device-pairing-title">{{ accessDenied ? 'Device pairing needs desktop access' : 'Pair a Child device' }}</h2>
        <p v-if="!accessDenied">Connect another machine to run tasks there. Keep both Shadow apps open while pairing.</p>
      </div>
      <button type="button" class="device-button" :disabled="loading || !!action" @click="refresh">{{ loading ? 'Checking…' : accessDenied ? 'Retry desktop access' : 'Refresh pairing' }}</button>
    </header>
    <p v-if="loadError" class="device-error" role="alert">{{ loadError }}</p>
    <p v-if="actionError" class="device-error" role="alert">{{ actionError }}</p>
    <p v-if="loading && !network" role="status">Loading device connection settings…</p>

    <template v-if="network">
      <div class="network-state">
        <span :class="{ 'device-error-text': network.state === 'error' }">
          {{ network.state === 'listening' ? 'Device listener is on' : network.state === 'error' ? 'Device listener could not start' : 'Device listener is off' }}
        </span>
        <code v-if="network.endpoint">{{ network.endpoint }}</code>
        <button v-if="network.enabled" type="button" class="device-button" :disabled="!!action || !!loadError" @click="disableNetwork">Turn off listener</button>
      </div>
      <p v-if="network.error" class="device-error" role="alert">{{ network.error }}</p>
      <p v-if="network.state === 'listening'" class="device-hint">Authenticated HTTP test connection · not encrypted. Only device traffic is exposed; Main’s app and administration stay on loopback. Turning this off disconnects remote devices.</p>
      <form v-if="network.state !== 'listening'" class="network-setup" @submit.prevent="enableNetwork">
        <p>Enable a device-only connection on your trusted LAN or VPN. Main’s app gateway stays on loopback.</p>
        <div class="network-fields">
          <label for="device-host">Main’s network address
            <select id="device-host" v-model="host" :disabled="!!action || !!loadError">
              <option v-if="!choices.length" value="">No private IPv4 address available</option>
              <option v-for="address in choices" :key="address.address" :value="address.address">{{ address.address }} — {{ address.name }}{{ address.address.startsWith('127.') ? ' (this machine only)' : '' }}</option>
            </select>
          </label>
          <details>
            <summary>Port settings</summary>
            <label for="device-port">Device port (1024–65535)
              <input id="device-port" v-model.number="port" type="number" min="1024" max="65535" step="1" required :disabled="!!action || !!loadError" />
            </label>
          </details>
        </div>
        <p v-if="!choices.length" class="device-hint">Connect Main to a private LAN or VPN, then refresh pairing.</p>
        <p v-else-if="host.startsWith('127.')" class="device-hint">Loopback cannot be reached from another machine. Connect to a LAN or VPN and refresh to select its address.</p>
        <label class="consent">
          <input v-model="httpAcknowledged" type="checkbox" :disabled="!!action || !!loadError" />
          <span>I understand this HTTP test connection is not encrypted. I will use only a trusted LAN/VPN, never expose this port to the public internet, and limit firewall access to trusted devices.</span>
        </label>
        <button type="submit" class="device-button primary" :disabled="!canEnable">{{ action === 'network' ? 'Starting listener…' : 'Enable device connection' }}</button>
        <p class="device-hint">This setting is saved and restored when Main restarts. Turn it off here when testing is finished.</p>
      </form>

      <div v-if="network.state === 'listening'" class="invitation-section">
        <template v-if="invitation">
          <h3>Enter these details in the Child setup</h3>
          <dl class="invitation-values">
            <div><dt>Main endpoint</dt><dd><code>{{ invitationEndpoint }}</code><button type="button" class="device-button" :disabled="!remaining" @click="copy(invitationEndpoint, 'Endpoint')">Copy endpoint</button></dd></div>
            <div><dt>Invitation ID</dt><dd><code>{{ invitation.offerId }}</code><button type="button" class="device-button" :disabled="!remaining" @click="copy(invitation.offerId, 'Invitation ID')">Copy ID</button></dd></div>
            <div><dt>PIN</dt><dd><code>{{ remaining ? invitation.pin : 'Expired' }}</code><button type="button" class="device-button" :disabled="!remaining" @click="copy(invitation.pin, 'PIN')">Copy PIN</button></dd></div>
          </dl>
          <p v-if="remaining" class="device-hint">Expires at {{ new Date(invitation.expiresAt).toLocaleTimeString() }} ({{ Math.ceil(remaining / 60) }} min remaining). Single use. Share only with the person at your Child device.</p>
          <p v-else class="device-hint" role="status">This invitation expired. Create another to try again; a request already submitted can still be verified below.</p>
        </template>
        <p v-else>Create a single-use invitation, then enter it in the other machine’s Child setup.</p>
        <button type="button" class="device-button primary" :disabled="!!action || !!loadError" @click="createInvitation">
          {{ action === 'invitation' ? 'Creating invitation…' : invitation ? 'Create another invitation' : 'Create invitation' }}
        </button>
        <p v-if="invitation" class="device-hint">A new invitation does not cancel an unused earlier one; it remains valid until its expiry.</p>
      </div>
    </template>

    <p v-if="copyStatus" role="status">{{ copyStatus }}</p>
    <p v-if="action" class="device-hint" role="status">Request in progress. <button type="button" class="device-button" @click="cancelAction">Cancel waiting</button></p>
    <div v-if="pending.length" class="pending-section">
      <h3>Verify pending devices</h3>
      <p>Only approve a request you recognize. Approval is not a connection; wait for Connected in the device inventory.</p>
      <PendingDeviceApproval v-for="device in pending" :key="`${device.pendingId}:${device.deviceIdentityFingerprint}:${device.credentialId}`"
        :device="device" :disabled="!!action || !!loadError" :busy="action === device.pendingId" @approve="approveDevice" />
    </div>
    <p v-else-if="network?.state === 'listening' && !loadError" class="device-hint">Waiting for a Child request. Requests appear here automatically after the invitation is entered.</p>
    <p v-for="device in approved" :key="device.nodeId" class="approval-progress" role="status">
      <template v-if="connection(device.nodeId) === 'connected'">{{ device.displayName }} is connected. Its available capabilities are listed below.</template>
      <template v-else-if="connection(device.nodeId) === 'revoked'">{{ device.displayName }} has been revoked and cannot connect.</template>
      <template v-else>{{ device.displayName }} is approved, but not connected. Keep Child open and check its connection status, network, and firewall.</template>
    </p>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { NodeInventoryEntry } from '../node-inventory.ts'
import PendingDeviceApproval from './PendingDeviceApproval.vue'
import {
  defaultDeviceHost, deviceAdminRequest, deviceHostChoices, DeviceAdministrationAccessError, invitationRemaining,
  parseDeviceInvitation, parseDeviceNetwork, parsePendingDevices, validateDeviceApproval,
  type DeviceInvitation, type DeviceNetwork, type PendingDevice, type deviceApprovalBody,
} from './device-administration.ts'

const props = defineProps<{ apiBase: string; nodes: readonly NodeInventoryEntry[] }>()
const emit = defineEmits<{ changed: [] }>()
const network = ref<DeviceNetwork>()
const pending = ref<PendingDevice[]>([])
const approved = ref<Array<{ nodeId: string; displayName: string }>>([])
const invitation = ref<DeviceInvitation>()
const invitationEndpoint = ref('')
const host = ref('')
const port = ref(3124)
const httpAcknowledged = ref(false)
const loading = ref(false)
const loadError = ref('')
const actionError = ref('')
const accessDenied = ref(false)
const action = ref('')
const copyStatus = ref('')
const now = ref(Date.now())
const choices = computed(() => network.value ? deviceHostChoices(network.value) : [])
const remaining = computed(() => invitation.value ? invitationRemaining(invitation.value, now.value) : 0)
const canEnable = computed(() => !action.value && !loadError.value && httpAcknowledged.value
  && choices.value.some(choice => choice.address === host.value) && Number.isInteger(port.value) && port.value >= 1024 && port.value <= 65535)
let poll: ReturnType<typeof setTimeout> | undefined
let clock: ReturnType<typeof setInterval> | undefined
let readController: AbortController | undefined
let actionController: AbortController | undefined
let mounted = false

function stopRead() {
  clearTimeout(poll)
  readController?.abort()
  readController = undefined
  loading.value = false
}

function applyNetwork(value: DeviceNetwork) {
  const first = !network.value
  if (invitationEndpoint.value && value.endpoint !== invitationEndpoint.value) {
    invitation.value = undefined
    copyStatus.value = ''
  }
  network.value = value
  if (first || !deviceHostChoices(value).some(choice => choice.address === host.value)) host.value = defaultDeviceHost(value)
  if (first) port.value = value.port
}

async function refresh() {
  stopRead()
  if (!mounted || document.hidden || action.value) return
  const controller = new AbortController()
  readController = controller
  loading.value = true
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const [settings, requests] = await Promise.all([
      deviceAdminRequest(props.apiBase, '/nodes/v1/network', signal).then(parseDeviceNetwork),
      deviceAdminRequest(props.apiBase, '/nodes/v1/pending', signal).then(parsePendingDevices),
    ])
    if (readController !== controller) return
    applyNetwork(settings)
    pending.value = requests
    loadError.value = ''
    accessDenied.value = false
  } catch (cause) {
    if (readController !== controller) return
    loadError.value = failure(cause)
    if (cause instanceof DeviceAdministrationAccessError) clearUnauthorizedState()
  } finally {
    if (readController === controller) {
      controller.abort()
      readController = undefined
      loading.value = false
      if (mounted && !document.hidden && !accessDenied.value) poll = setTimeout(refresh, 5_000)
    }
  }
}

function failure(cause: unknown): string {
  return cause instanceof Error && cause.message !== 'Failed to fetch' && cause.name !== 'TimeoutError'
    ? cause.message : 'Cannot reach Main’s device administration. Check the backend connection and retry.'
}

function clearUnauthorizedState() {
  accessDenied.value = true
  network.value = undefined
  pending.value = []
  approved.value = []
  invitation.value = undefined
  invitationEndpoint.value = ''
  httpAcknowledged.value = false
  copyStatus.value = ''
}

async function mutate(name: string, run: (signal: AbortSignal) => Promise<void>) {
  if (action.value || loadError.value) return
  stopRead()
  const controller = new AbortController()
  actionController = controller
  action.value = name
  actionError.value = ''
  try {
    await run(AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]))
  } catch (cause) {
    if (actionController === controller) {
      if (cause instanceof DeviceAdministrationAccessError) {
        clearUnauthorizedState()
        loadError.value = failure(cause)
      } else {
        actionError.value = `${failure(cause)} The request may have reached Main; refresh before retrying.`
      }
    }
  } finally {
    if (actionController === controller) {
      actionController = undefined
      action.value = ''
      emit('changed')
      if (!accessDenied.value) void refresh()
    }
  }
}

function cancelAction() {
  if (!actionController) return
  actionController.abort()
  actionController = undefined
  action.value = ''
  actionError.value = 'Stopped waiting. Main may still have applied the request. Refresh and check its state before retrying.'
  emit('changed')
  void refresh()
}

async function enableNetwork() {
  if (!canEnable.value) return
  await mutate('network', async signal => {
    const value = parseDeviceNetwork(await deviceAdminRequest(props.apiBase, '/nodes/v1/network', signal, 'PUT', {
      version: 1, enabled: true, host: host.value, port: port.value, allowInsecureLocalTransport: true,
    }))
    if (!signal.aborted) { applyNetwork(value); httpAcknowledged.value = false }
  })
}

async function disableNetwork() {
  const settings = network.value
  if (!settings) return
  await mutate('disable', async signal => {
    const value = parseDeviceNetwork(await deviceAdminRequest(props.apiBase, '/nodes/v1/network', signal, 'PUT', {
      version: 1, enabled: false, host: settings.host, port: settings.port, allowInsecureLocalTransport: settings.allowInsecureLocalTransport,
    }))
    if (!signal.aborted) { applyNetwork(value); httpAcknowledged.value = false }
  })
}

async function createInvitation() {
  if (network.value?.state !== 'listening' || !network.value.endpoint) return
  const endpoint = network.value.endpoint
  await mutate('invitation', async signal => {
    const value = parseDeviceInvitation(await deviceAdminRequest(props.apiBase, '/pair/v1/offers', signal, 'POST'))
    if (!signal.aborted) {
      invitation.value = value
      invitationEndpoint.value = endpoint
      now.value = Date.now()
      copyStatus.value = ''
    }
  })
}

async function approveDevice(device: PendingDevice, body: ReturnType<typeof deviceApprovalBody>) {
  await mutate(device.pendingId, async signal => {
    const value = await deviceAdminRequest(props.apiBase, `/nodes/v1/pending/${encodeURIComponent(device.pendingId)}/approve`, signal, 'POST', body)
    validateDeviceApproval(value, device)
    if (!signal.aborted) {
      pending.value = pending.value.filter(value => value.pendingId !== device.pendingId)
      approved.value = [...approved.value.filter(value => value.nodeId !== device.nodeId), { nodeId: device.nodeId, displayName: device.displayName }]
    }
  })
}

function connection(nodeId: string) { return props.nodes.find(node => node.nodeId === nodeId)?.connection }
async function copy(value: string, label: string) {
  if (!remaining.value) return
  try {
    await navigator.clipboard.writeText(value)
    if (mounted) copyStatus.value = `${label} copied.`
  } catch {
    if (mounted) copyStatus.value = `Could not copy ${label.toLowerCase()}. Select and copy the value above instead.`
  }
}

function visibilityChanged() {
  now.value = Date.now()
  if (document.hidden) { stopRead(); cancelAction() }
  else void refresh()
}
watch(() => props.apiBase, () => {
  stopRead()
  cancelAction()
  network.value = undefined
  pending.value = []
  approved.value = []
  invitation.value = undefined
  invitationEndpoint.value = ''
  httpAcknowledged.value = false
  loadError.value = ''
  actionError.value = ''
  copyStatus.value = ''
  accessDenied.value = false
  void refresh()
})
onMounted(() => {
  mounted = true
  document.addEventListener('visibilitychange', visibilityChanged)
  clock = setInterval(() => { now.value = Date.now() }, 1_000)
  void refresh()
})
onUnmounted(() => {
  mounted = false
  stopRead()
  actionController?.abort()
  actionController = undefined
  clearInterval(clock)
  document.removeEventListener('visibilitychange', visibilityChanged)
})
</script>

<style scoped src="./device-administration.css"></style>
