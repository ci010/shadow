<template>
  <div class="otio-file" :aria-busy="loading">
    <OtioViewer v-if="snapshot" :model="snapshot.model" :source="snapshot.source" :api-base="apiBase" :active="active"
      :can-review="canReview" :media-for="mediaFor" :unlinked="unlinked" @added="emit('added')" />
    <NodeOfflineState v-else-if="offline" :checking="loading" :description="t('This preview will be available when the owning node reconnects.')" @retry="load" />
    <div v-else-if="error" class="notice" role="alert"><p>{{ t('Could not open this timeline.') }}</p><p class="selectable-text">{{ error }}</p><button class="btn btn-sm" type="button" @click="load">{{ t('Retry preview') }}</button></div>
    <p v-else class="notice" role="status">{{ t('Loading timeline…') }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { t } from '../../i18n.ts'
import { apiUrl } from '../../api-url.ts'
import { useSessionFiles } from '../../composables/useSessionFiles.ts'
import { readAttachmentBytes } from '../../attachment-preview.ts'
import { isNodeOfflineError } from '../../workdir-request-error.ts'
import { MAX_OTIO_BYTES, parseOtio, type OtioModel, type OtioNode } from '../../otio-model.ts'
import { isAbsoluteMedia, resolveOtioMedia, type OtioDocument } from '../../otio-review.ts'
import NodeOfflineState from './NodeOfflineState.vue'
import OtioViewer from './OtioViewer.vue'

// The parent keys this instance by file and owner. A hidden tab keeps its review but never plays media.
const props = defineProps<{ apiBase: string; folderId?: string; sessionId: string; sessionWorkspace?: boolean;
  path: string; mtime: string | null; active: boolean; canReview: boolean; remote: boolean; sourceBlob?: Blob; attachmentUrl?: string }>()
const emit = defineEmits<{ added: [] }>()
const files = computed(() => useSessionFiles(props.apiBase, props.folderId, props.sessionWorkspace))
const snapshot = shallowRef<{ model: OtioModel; source: OtioDocument; localRoot?: string }>()
const unlinked = computed(() => props.attachmentUrl || props.sourceBlob ? t('Linked media is not loaded from a standalone attachment or archive.')
  : props.remote ? t('This remote workspace supports timeline inspection, not media streaming.') : '')
const loading = ref(false), error = ref(''), offline = ref(false)
let request: AbortController | undefined
function mediaFor(node: OtioNode) {
  if (unlinked.value || !node.targetUrl) return null
  const medium = resolveOtioMedia(props.path, node.targetUrl, snapshot.value?.localRoot)
  return medium && { ...medium, url: files.value.rawUrl(props.sessionId, medium.path) }
}
async function load() {
  request?.abort()
  if (!props.active) return
  const controller = new AbortController(), { signal } = controller
  request = controller
  loading.value = true; offline.value = false; error.value = ''
  try {
    const limit = t('Timelines larger than 8 MiB cannot be previewed. Use Download for the original.')
    let blob: Blob
    if (props.attachmentUrl) {
      const read = await readAttachmentBytes(props.attachmentUrl, AbortSignal.any([signal, AbortSignal.timeout(30_000)]), MAX_OTIO_BYTES)
      if (read.truncated) throw new Error(limit)
      blob = new Blob([read.bytes as Uint8Array<ArrayBuffer>])
    } else if (props.sourceBlob) blob = props.sourceBlob
    else if (props.remote) {
      const text = await files.value.preview(props.sessionId, props.path, 65536, signal)
      if (text.binary || text.truncated || text.content == null) throw new Error(t('This remote timeline exceeds the text preview limit or is not readable as text.'))
      blob = new Blob([text.content])
    } else blob = await files.value.readBlob(props.sessionId, props.path, signal, MAX_OTIO_BYTES, limit)
    if (blob.size > MAX_OTIO_BYTES) throw new Error(limit)
    const bytes = await blob.arrayBuffer()
    signal.throwIfAborted()
    const model = parseOtio(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    // A media ticket/URL is not a filesystem locator. Include only the admitted path for
    // this API's attachment, never the URL, bearer material, or an external query string.
    let sourcePath = props.path
    if (props.attachmentUrl) {
      const url = new URL(props.attachmentUrl, props.apiBase), endpoint = apiUrl(props.apiBase, '/api/media')
      if (url.origin === endpoint.origin && url.pathname === endpoint.pathname) sourcePath = url.searchParams.get('path') || sourcePath
    }
    const document: OtioDocument = { path: sourcePath, owner: props.folderId ? { folder: props.folderId }
      : { session: props.sessionId, space: props.attachmentUrl ? 'attachment' : props.sessionWorkspace ? 'session-files' : 'workdir' },
      ...(props.mtime && { modified: props.mtime }) }
    if (!props.remote && globalThis.crypto?.subtle) {
      const hash = await crypto.subtle.digest('SHA-256', bytes)
      document.sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('')
    }
    // Absolute file references are useful in exported edits, but only relative to the verified local owner.
    // Don't enumerate a directory for ordinary relative media references.
    let localRoot: string | undefined
    if (!unlinked.value && model.nodes.some(node => node.targetUrl && isAbsoluteMedia(node.targetUrl))) {
      const dir = props.path.split('/').slice(0, -1).join('/')
      const listing = await files.value.listDir(props.sessionId, dir, signal).catch(() => undefined)
      if (listing?.workdir?.kind === 'local') localRoot = listing.workdir.displayPath ?? undefined
    }
    if (!signal.aborted) snapshot.value = { model, source: document, localRoot }
  } catch (cause) {
    if (!signal.aborted) { offline.value = isNodeOfflineError(cause); error.value = cause instanceof Error ? cause.message : t('Could not open this timeline.') }
  } finally { if (request === controller) { request = undefined; loading.value = false } }
}
watch(() => props.active, active => { if (!active) request?.abort(); else if (!snapshot.value) void load() }, { immediate: true })
onBeforeUnmount(() => request?.abort())
</script>

<style scoped>
.otio-file { display: flex; flex-direction: column; align-self: stretch; width: 100%; min-width: 0; min-height: 0; height: 100%; background: var(--c-bg-card); }
.notice { margin: 0; padding: 18px; font-size: 13px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.notice p { margin: 0 0 8px; }
.notice[role="alert"] > p:first-child { color: var(--c-error); }
</style>
