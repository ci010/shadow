<template>
  <ComposerPopover ref="popover" :label="t('Execution location')" :title="label" :disabled="disabled" :width="360" @opened="refresh" @closed="closed">
    <template #trigger>
      <span :class="folder ? 'i-lucide-folder' : selected ? 'i-lucide-monitor' : 'i-lucide-laptop'" aria-hidden="true" />
      <span class="location-label">{{ label }}</span>
      <span class="i-lucide-chevron-down" aria-hidden="true" />
    </template>
    <template #default="{ close }">
      <div class="location-header"><strong>{{ t('Execution location') }}</strong><button class="location-refresh" :disabled="loading" @click="refresh">{{ t('Refresh') }}</button></div>
      <button class="location-option" :aria-pressed="!folder && !selected" @click="emit('select', undefined); close()">
        <span class="i-lucide-laptop" aria-hidden="true" /><span><strong>{{ t('This computer') }}</strong><small>{{ t('Managed conversation folder') }}</small></span>
        <span v-if="!folder && !selected" class="i-lucide-check" aria-hidden="true" />
      </button>
      <p v-if="loading" class="location-note" role="status">{{ t('Loading execution locations...') }}</p>
      <p v-if="error" class="location-error" role="alert">{{ error }}</p>
      <template v-if="folderTargets.length">
        <div class="location-device"><strong>{{ t('Project folders') }}</strong></div>
        <button v-for="target in folderTargets" :key="target.folder.id"
          class="location-option" :disabled="!target.available || loading || !!error"
          :aria-label="target.folder.name" :aria-pressed="folder?.id === target.folder.id"
          @click="emit('select', { kind: 'folder', folder: target.folder }); close()">
          <span class="i-lucide-folder" aria-hidden="true" />
          <span><strong>{{ target.folder.name }}</strong><small>{{ target.detail }}</small><small v-if="target.unavailableReason">{{ target.unavailableReason }}</small></span>
          <span v-if="folder?.id === target.folder.id" class="i-lucide-check" aria-hidden="true" />
        </button>
      </template>
      <template v-if="targets.length">
        <div class="location-device"><strong>{{ t('Remote devices') }}</strong><span>{{ t('From scratch') }}</span></div>
        <button v-for="target in targets" :key="target.nodeId"
          class="location-option" :disabled="!target.available || loading || !!error"
          :aria-label="t('Start from scratch on {nodeName}', { nodeName: target.nodeName })"
          :aria-pressed="!folder && selected?.nodeId === target.nodeId && !selected?.capabilityId"
          @click="emit('select', { kind: 'node', node: target }); close()">
          <span class="i-lucide-monitor" aria-hidden="true" />
          <span><strong>{{ target.nodeName }}</strong><small>{{ target.unavailableReason || t('New managed conversation folder') }}</small></span>
          <span v-if="!folder && selected?.nodeId === target.nodeId && !selected?.capabilityId" class="i-lucide-check" aria-hidden="true" />
        </button>
      </template>
      <p class="location-note">{{ t('Conversations and managed folders are created on first send.') }}</p>
    </template>
  </ComposerPopover>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, onDeactivated, onUnmounted, ref, watch } from 'vue'
import ComposerPopover from './ComposerPopover.vue'
import { fetchNodeInventory, type NodeInventoryEntry } from '../node-inventory.ts'
import { remoteNodeTargets, type RemoteChatTarget } from '../remote-conversations.ts'
import { createFoldersClient, type FolderRecord } from '../folders-client.ts'
import { projectFolderTargets, type ExecutionLocation } from '../execution-locations.ts'

const props = defineProps<{ apiBase: string; projectId: string; folder?: FolderRecord; selected?: RemoteChatTarget; disabled?: boolean }>()
const emit = defineEmits<{ select: [target: ExecutionLocation | undefined] }>()
const popover = ref<InstanceType<typeof ComposerPopover>>()
const label = computed(() => props.folder?.name ?? (props.selected ? `${props.selected.nodeName} · ${props.selected.displayName}` : t('This computer')))
const nodes = ref<NodeInventoryEntry[]>([])
const folders = ref<FolderRecord[]>([])
const folderTargets = computed(() => projectFolderTargets(props.projectId, folders.value, nodes.value))
const targets = computed(() => remoteNodeTargets(nodes.value))
const loading = ref(false)
const error = ref('')
let request: AbortController | undefined
let opened = false
async function openRemote() {
  if (props.disabled) return
  await popover.value?.show()
}
function closed() {
  opened = false
  cancel()
}
function cancel() {
  request?.abort()
  request = undefined
  loading.value = false
}
async function refresh() {
  cancel()
  opened = true
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)])
    const [result, projectFolders] = await Promise.all([
      fetchNodeInventory(props.apiBase, 'main', signal),
      createFoldersClient(props.apiBase).list(signal),
    ])
    if (!controller.signal.aborted && request === controller) {
      nodes.value = [...result.nodes]
      folders.value = projectFolders
    }
  } catch (cause) {
    if (!controller.signal.aborted) {
      nodes.value = []
      folders.value = []
      error.value = cause instanceof Error ? cause.message : t('Could not load execution locations. Retry.')
      controller.abort()
    }
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}
watch(() => [props.apiBase, props.projectId], () => {
  cancel()
  nodes.value = []
  folders.value = []
  error.value = ''
  if (opened) void refresh()
}, { flush: 'sync' })
onDeactivated(closed)
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
