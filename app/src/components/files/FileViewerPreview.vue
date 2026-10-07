<template>
  <div class="file-viewer-preview" :aria-label="`Preview ${name}`" :aria-busy="loading">
    <p v-if="fileViewerFormat(extension) === 'gis'" class="viewer-network-notice" role="status">Map previews use external map tiles and stylesheet resources. Map providers can see the requested map area.</p>
    <NodeOfflineState v-if="offline" :checking="loading" description="This preview will be available when the owning node reconnects." @retry="load" />
    <div v-else-if="error" class="viewer-notice" role="alert">
      <p>{{ error }} Use Download to save the original file.</p>
      <button class="viewer-retry" type="button" @click="load">Retry preview</button>
    </div>
    <p v-else-if="loading" class="viewer-loading" role="status">Loading file preview...</p>
    <div v-show="!error && !offline" ref="container" class="viewer-container selectable-text" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { FileViewer } from '@open-file-viewer/core'
import { useSessionFiles } from '../../composables/useSessionFiles.ts'
import { useTheme } from '../../composables/useTheme.ts'
import { isNodeOfflineError } from '../../workdir-request-error.ts'
import NodeOfflineState from './NodeOfflineState.vue'
import { fileViewerFormat } from '../../file-viewer.ts'
import '../../open-file-viewer.css'

const props = defineProps<{ apiBase: string; sessionId: string; folderId?: string; path: string; name: string; active: boolean; sourceBlob?: Blob }>()
const { isDark } = useTheme()
const extension = computed(() => props.name.slice(props.name.lastIndexOf('.')).toLowerCase())
const container = ref<HTMLElement>()
const loading = ref(false)
const error = ref('')
const offline = ref(false)
let request: AbortController | undefined
let viewer: FileViewer | undefined
let source: Blob | undefined
let sdk: typeof import('../../open-file-viewer-sdk.ts') | undefined

function destroy(): void {
  request?.abort()
  request = undefined
  viewer?.destroy()
  viewer = undefined
  source = undefined
  loading.value = false
}
function mount(controller: AbortController): void {
  if (!container.value || !source || !sdk || controller.signal.aborted) return
  viewer?.destroy()
  loading.value = true
  const file = source
  viewer = sdk.mountFileViewer({
    container: container.value, file, fileName: props.name, theme: isDark.value ? 'dark' : 'light',
    onLoad: loaded => { if (!controller.signal.aborted && loaded.source === file) loading.value = false },
    onError: (cause, failed) => {
      if (controller.signal.aborted || (failed && failed.source !== file)) return
      loading.value = false
      error.value = `Could not render this file: ${cause.message}`
    },
    onUnsupported: unsupported => {
      if (controller.signal.aborted || unsupported.source !== file) return
      loading.value = false
      error.value = 'This file format cannot be previewed by the installed viewer.'
    },
  })
}
async function load(): Promise<void> {
  destroy()
  error.value = ''
  if (!props.active || !(props.sessionId || props.folderId)) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  try {
    const [blob, module] = await Promise.all([
      props.sourceBlob ?? useSessionFiles(props.apiBase, props.folderId).readBlob(props.sessionId, props.path, controller.signal),
      import('../../open-file-viewer-sdk.ts'),
    ])
    if (controller.signal.aborted) return
    offline.value = false
    source = blob
    sdk = module
    mount(controller)
  } catch (cause) {
    if (controller.signal.aborted) return
    viewer?.destroy()
    viewer = undefined
    source = undefined
    loading.value = false
    offline.value = isNodeOfflineError(cause)
    error.value = offline.value ? '' : cause instanceof Error ? cause.message : 'Could not load this file. Retry the preview.'
  }
}
onMounted(() => void load())
watch(() => [props.apiBase, props.sessionId, props.folderId, props.path, props.name, props.active, props.sourceBlob], () => {
  offline.value = false
  void load()
}, { flush: 'post' })
watch(isDark, () => {
  if (!request || !source || error.value || !props.active) return
  // Rebuild from the already authorized bytes; a theme change is not a file request.
  request.abort()
  request = new AbortController()
  try { mount(request) } catch (cause) {
    loading.value = false
    error.value = cause instanceof Error ? cause.message : 'Could not update the preview theme. Retry the preview.'
  }
})
onUnmounted(destroy)
</script>

<style scoped>
.file-viewer-preview { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-width: 0; min-height: 280px; }
.viewer-container { flex: 1; width: 100%; min-height: 0; }
.viewer-network-notice { flex: 0 0 auto; margin: 0; padding: 8px 16px; border-bottom: 1px solid var(--c-border); background: var(--c-info-bg); color: var(--c-info); font-size: 12px; line-height: 1.5; }
.viewer-notice { padding: 24px; color: var(--c-error); font-size: 13px; overflow-wrap: anywhere; }
.viewer-loading { position: absolute; z-index: 1; top: 8px; left: 16px; margin: 0; padding: 8px; background: var(--c-bg-card); color: var(--c-text-secondary); font-size: 13px; }
.viewer-retry { margin-top: 12px; padding: 6px 10px; min-height: 32px; border: 1px solid var(--c-control-border); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; }
.viewer-retry:hover { background: var(--c-bg-muted); }
.viewer-retry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (pointer: coarse) { .viewer-retry { min-height: 44px; } }
</style>
