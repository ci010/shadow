<template>
  <ComposerPopover ref="popover" :label="remoteOnly ? 'Open remote folder' : 'Execution location'" :title="label" :disabled="disabled" :width="360" @opened="refresh" @closed="closed">
    <template #trigger>
      <span :class="selected ? 'i-lucide-monitor' : 'i-lucide-laptop'" aria-hidden="true" />
      <span class="location-label">{{ label }}</span>
      <span class="i-lucide-chevron-down" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div class="location-header"><strong>{{ remoteOnly ? 'Open remote folder' : 'Execution location' }}</strong><button class="location-refresh" :disabled="loading" @click="refresh">Refresh</button></div>
      <button v-if="!remoteOnly" class="location-option" :aria-pressed="!selected" @click="emit('select', undefined); close()">
        <span class="i-lucide-laptop" aria-hidden="true" /><span><strong>This computer</strong><small>{{ localLabel || 'Managed conversation folder' }}</small></span>
        <span v-if="!selected" class="i-lucide-check" aria-hidden="true" />
      </button>
      <p v-if="loading" class="location-note" role="status">Loading connected devices...</p>
      <p v-if="error" class="location-error" role="alert">{{ error }}</p>
      <template v-for="node in nodes" :key="node.nodeId">
        <div class="location-device"><strong>{{ node.displayName }}</strong><span>{{ node.connection === 'connected' ? 'Connected' : node.connection === 'revoked' ? 'Revoked' : 'Offline' }}</span></div>
        <button v-for="target in targets.filter(item => item.nodeId === node.nodeId)" :key="target.capabilityId"
          class="location-option" :disabled="!target.available || loading || !!error"
          :aria-label="`${target.nodeName}: ${target.displayName}`"
          :aria-pressed="selected?.nodeId === target.nodeId && selected?.capabilityId === target.capabilityId"
          @click="emit('select', target); close()">
          <span class="i-lucide-folder" aria-hidden="true" />
          <span><strong>{{ target.displayName }}</strong><small>{{ target.displayPath || 'Authorized remote workspace' }}</small></span>
          <span v-if="selected?.nodeId === target.nodeId && selected?.capabilityId === target.capabilityId" class="i-lucide-check" aria-hidden="true" />
        </button>
        <p v-if="!targets.some(item => item.nodeId === node.nodeId)" class="location-note">No workspaces available on this device.</p>
      </template>
      <p v-if="!loading && !error && !nodes.length" class="location-note">No Child devices registered. Connect a device before choosing a remote workspace.</p>
      <p class="location-note">The conversation is created when you send. Paired devices run supported operations without additional approval.</p>
    </template>
  </ComposerPopover>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref } from 'vue'
import ComposerPopover from './ComposerPopover.vue'
import { fetchNodeInventory, type NodeInventoryEntry } from '../node-inventory.ts'
import { remoteConversationTargets, type RemoteConversationTarget } from '../remote-conversations.ts'

const props = defineProps<{ apiBase: string; selected?: RemoteConversationTarget; localLabel?: string; disabled?: boolean }>()
const emit = defineEmits<{ select: [target: RemoteConversationTarget | undefined] }>()
const popover = ref<InstanceType<typeof ComposerPopover>>()
const remoteOnly = ref(false)
const label = computed(() => props.selected ? `${props.selected.nodeName} · ${props.selected.displayName}` : 'This computer')
const nodes = ref<NodeInventoryEntry[]>([])
const targets = computed(() => remoteConversationTargets(nodes.value))
const loading = ref(false)
const error = ref('')
let request: AbortController | undefined
async function openRemote() {
  if (props.disabled) return
  remoteOnly.value = true
  await popover.value?.show()
}
function closed() {
  cancel()
  remoteOnly.value = false
}
function cancel() {
  request?.abort()
  request = undefined
  loading.value = false
}
async function refresh() {
  cancel()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const result = await fetchNodeInventory(props.apiBase, 'main', AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]))
    if (!controller.signal.aborted) nodes.value = result.nodes.filter(node => node.role === 'child')
  } catch (cause) {
    if (!controller.signal.aborted) {
      nodes.value = []
      error.value = cause instanceof Error ? cause.message : 'Could not load devices. Retry.'
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
onUnmounted(cancel)
defineExpose({ openRemote })
</script>

<style scoped>
.location-label { max-width: min(32ch, 45vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.location-header, .location-device { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px; font-size: 12px; }
.location-refresh { padding: 4px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.location-refresh:hover:not(:disabled) { background: var(--c-bg-muted); color: var(--c-text); }
.location-refresh:disabled { opacity: .55; cursor: default; }
.location-refresh:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.location-device { margin-top: 6px; border-top: 1px solid var(--c-border); }
.location-device span, .location-note, .location-option small { color: var(--c-text-secondary); }
.location-option { display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.location-option > span:nth-child(2) { flex: 1; min-width: 0; }
.location-option strong, .location-option small { display: block; overflow-wrap: anywhere; }
.location-option small { margin-top: 3px; font-size: 12px; }
.location-option:hover:not(:disabled), .location-option[aria-pressed="true"] { background: var(--c-bg-muted); }
.location-option:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.location-option:disabled { opacity: .55; cursor: not-allowed; }
.location-note, .location-error { margin: 8px; font-size: 12px; line-height: 1.5; }
.location-error { color: var(--c-error); }
</style>
