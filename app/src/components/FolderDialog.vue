<template>
  <Teleport to="body">
    <OverlayTransition>
    <div v-if="mode" class="folder-dialog-backdrop" @click.self="close" @keydown="dialogKeydown">
      <section ref="dialog" class="folder-dialog" role="dialog" aria-modal="true" aria-labelledby="folder-dialog-title" tabindex="-1">
        <header>
          <h2 id="folder-dialog-title">{{ mode !== 'clone' ? t('Open folder') : t('Clone repository') }}</h2>
          <button class="folder-icon-button" :aria-label="t('Close folder dialog')" :disabled="cloneView.state === 'cancelling'" @click="close">×</button>
        </header>
        <p class="dialog-intro">{{ mode !== 'clone' ? t('Add an existing folder to this project. Your files stay where they are.') : t('Clone a repository into a new folder on Main.') }}</p>
        <form @submit.prevent="submit">
          <label v-if="mode === 'clone'" class="dialog-field">
            <span>{{ t('Repository URL') }}</span>
            <input ref="urlInput" v-model="url" type="text" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo.git" :disabled="cloneActive" required />
            <small>{{ t('HTTPS or SSH. Use Git authentication rather than a token in the URL.') }}</small>
          </label>
          <label v-if="mode !== 'clone'" class="dialog-field">
            <span>{{ t('Device') }}</span>
            <select v-model="nodeId" :disabled="busy" @change="deviceChanged">
              <option v-for="device in devices" :key="device.nodeId" :value="device.nodeId" :disabled="!device.online || !device.supported">
                {{ device.name }} · {{ device.nodeId }} ({{ device.role }}){{ !device.online ? ' · ' + t('Offline') : !device.supported ? ' · ' + t('Update required') : '' }}
              </option>
            </select>
          </label>
          <button type="button" class="btn" :disabled="busy || cloneActive" @click="loadDevices">{{ t('Refresh devices') }}</button>
          <label class="dialog-field">
            <span>{{ mode !== 'clone' ? t('Folder path') : t('Parent folder') }}</span>
            <span class="path-input-row">
              <input ref="pathInput" v-model="path" type="text" autocomplete="off" spellcheck="false" :placeholder="t('Absolute folder path')" :disabled="busy || cloneActive" required />
              <button type="button" class="btn" :disabled="busy || cloneActive" @click="browse(path)">{{ busy ? t('Choosing…') : t('Browse…') }}</button>
            </span>
            <small>{{ t('Enter a path on the selected device, or browse its directories below.') }}</small>
          </label>
          <div class="directory-browser" aria-live="polite">
            <p v-if="busy" role="status">{{ t('Loading directories…') }}</p>
            <template v-if="listing">
              <p class="directory-location">{{ selectedDevice?.name }} · {{ nodeId }}: {{ listing.path }}</p>
              <button type="button" class="btn" :disabled="busy || !listing.parent || cloneActive" @click="browse(listing.parent ?? '')">{{ t('Parent directory') }}</button>
              <ul class="directory-list">
                <li v-for="entry in listing.directories" :key="entry.path"><button type="button" :disabled="busy || cloneActive" @click="browse(entry.path)"><span class="i-lucide-folder" aria-hidden="true" /> {{ entry.name }}</button></li>
              </ul>
              <p v-if="!listing.directories.length">{{ t('No subdirectories') }}</p>
              <p v-if="listing.truncated">{{ t('Too many directories. Enter a path to continue.') }}</p>
            </template>
          </div>
          <label v-if="mode === 'clone'" class="dialog-field">
            <span>{{ t('New folder name') }}</span>
            <input v-model="directoryName" type="text" autocomplete="off" spellcheck="false" :disabled="cloneActive" @input="directoryEdited = true" required />
          </label>
          <p v-if="mode === 'clone' && path && directoryName" class="destination-preview"><span>{{ t('Destination') }}</span><span>{{ destination }}</span></p>
          <div v-if="mode === 'clone' && cloneView.state !== 'idle'" class="clone-status" aria-live="polite">
            <strong>{{ cloneStatus }}</strong>
            <p v-if="cloneView.state === 'running' || cloneView.state === 'starting'">{{ t('You can cancel while the repository is being downloaded.') }}</p>
            <p v-if="cloneView.state === 'succeeded'">{{ t('The repository folder is ready in the sidebar. Use its + button to start a conversation.') }}</p>
            <p v-if="cloneView.state === 'failed' || cloneView.state === 'cancelled' || cloneView.state === 'unknown'">{{ t('Any partial checkout is kept on disk; it is not deleted automatically.') }}</p>
            <p v-if="cloneView.operation?.destination" class="checkout-path">{{ cloneView.operation.destination }}</p>
          </div>
          <p v-if="error || (mode === 'clone' && cloneView.error)" class="folder-error" role="alert">{{ error || cloneView.error }}</p>
          <button v-if="error && !cloneActive" type="button" class="btn" :disabled="busy" @click="loadDevices">{{ t('Retry') }}</button>
          <footer>
            <template v-if="mode === 'clone' && cloneActive">
              <button v-if="cloneView.state === 'unknown'" class="btn" type="button" @click="controller.refresh()">{{ t('Retry status') }}</button>
              <button class="btn" type="button" :disabled="cloneView.state === 'cancelling'" @click="controller.cancel()">{{ cloneView.state === 'cancelling' ? t('Cancelling…') : t('Cancel clone') }}</button>
            </template>
            <template v-else>
              <button class="btn" type="button" @click="close">{{ cloneView.state === 'succeeded' && mode === 'clone' ? t('Done') : t('Cancel') }}</button>
              <button v-if="mode === 'clone' && cloneView.state === 'succeeded'" class="btn" type="button" @click="resetClone">{{ t('Clone another repository') }}</button>
              <button v-if="mode !== 'clone' || cloneView.state !== 'succeeded'" class="btn primary" type="submit" :disabled="busy">{{ busy ? t('Opening…') : mode !== 'clone' ? t('Open folder') : cloneView.state === 'idle' ? t('Clone repository') : t('Retry clone') }}</button>
            </template>
          </footer>
        </form>
      </section>
    </div>
    </OverlayTransition>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { createCloneController, type CloneView, type FolderRecord, type FoldersClient } from '../folders-client.ts'
import { isAbsoluteFolderPath, suggestCloneDirectory } from '../folders-sidebar.ts'
import OverlayTransition from './OverlayTransition.vue'
import { useInstallationContext } from '../composables/useInstallationContext.ts'

const props = defineProps<{ mode: 'open' | 'remote' | 'clone' | null; client: FoldersClient }>()
const emit = defineEmits<{
  close: []
  registered: [folder: FolderRecord]
  status: [view: CloneView]
}>()
const installation = useInstallationContext()
const dialog = ref<HTMLElement>()
const urlInput = ref<HTMLInputElement>()
const pathInput = ref<HTMLInputElement>()
const path = ref('')
const url = ref('')
const directoryName = ref('')
const directoryEdited = ref(false)
const busy = ref(false)
const error = ref('')
const cloneView = ref<CloneView>({ state: 'idle' })
const devices = ref<Awaited<ReturnType<FoldersClient['pickerDevices']>>>([])
const nodeId = ref('')
const selectedDevice = computed(() => devices.value.find(d => d.nodeId === nodeId.value))
const listing = ref<Awaited<ReturnType<FoldersClient['browseDirectory']>>>()
const cloneActive = computed(() => props.mode === 'clone' && ['starting', 'running', 'cancelling', 'unknown'].includes(cloneView.value.state))
const destination = computed(() => `${path.value.replace(/[\\/]+$/, '')}${path.value.includes('\\') ? '\\' : '/'}${directoryName.value}`)
const cloneStatus = computed(() => ({
  idle: '', starting: t('Starting clone…'), running: t('Cloning repository…'), cancelling: t('Cancelling clone…'),
  succeeded: t('Repository cloned'), failed: t('Clone failed'), cancelled: t('Clone cancelled'), unknown: t('Clone status unavailable'),
})[cloneView.value.state])
let request: AbortController | undefined
let returnFocus: HTMLElement | null = null
let deactivated = false

const controller = createCloneController(props.client, view => {
  cloneView.value = view
  emit('status', view)
  if (view.state === 'succeeded' && view.operation?.folder) emit('registered', view.operation.folder)
})

watch(url, value => {
  if (!directoryEdited.value) directoryName.value = suggestCloneDirectory(value)
})
watch(() => props.mode, async (mode, previous) => {
  error.value = ''
  if (!mode) {
    request?.abort()
    busy.value = false
    if (!deactivated && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    return
  }
  deactivated = false
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (mode !== previous) { path.value = ''; listing.value = undefined; nodeId.value = '' }
  await nextTick()
  ;(mode === 'clone' ? urlInput.value : pathInput.value)?.focus({ preventScroll: true })
  await loadDevices()
})

async function loadDevices() {
  if (cloneActive.value) return
  request?.abort()
  const abort = new AbortController()
  request = abort
  busy.value = true
  error.value = ''
  try {
    const result = await props.client.pickerDevices(abort.signal)
    if (request !== abort || abort.signal.aborted) return
    devices.value = result
    if (!nodeId.value) {
      // Match an actual advertised identity; browser/mobile placeholders are never guessed into nodes.
      const current = installation.value.mode === 'client' ? undefined : result.find(d =>
        d.nodeId === installation.value.localNodeId && d.role === installation.value.mode)
      const preferred = props.mode === 'clone' ? result.find(d => d.role === 'main')
        : props.mode === 'remote' ? result.find(d => d.online && d.supported &&
          (current ? d.nodeId !== current.nodeId : d.role === 'child'))
        : current?.online && current.supported ? current : result.find(d => d.role === 'main')
      nodeId.value = preferred?.nodeId ?? result.find(d => d.role === 'main')?.nodeId ?? ''
    }
    if (!selectedDevice.value?.online || !selectedDevice.value.supported) throw new Error(t('The selected device is offline or needs an update. Choose another device or retry.'))
  } catch (cause) {
    if (!abort.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load devices. Retry.')
  } finally { if (request === abort) { request = undefined; busy.value = false } }
  if (!error.value) await browse(path.value)
}
function deviceChanged() {
  request?.abort()
  path.value = ''
  listing.value = undefined
  void browse('')
}
async function browse(directory: string) {
  if (cloneActive.value) return
  request?.abort()
  const abort = new AbortController()
  request = abort
  const device = nodeId.value
  path.value = directory
  busy.value = true
  error.value = ''
  listing.value = undefined
  try {
    const result = await props.client.browseDirectory(device, directory, abort.signal)
    if (abort.signal.aborted || request !== abort || device !== nodeId.value) return
    listing.value = result
    path.value = result.path
  } catch (cause) {
    if (!abort.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not browse this directory. Retry.')
  } finally { if (request === abort) { request = undefined; busy.value = false } }
}
async function submit() {
  if (busy.value || cloneActive.value) return
  error.value = ''
  if (!isAbsoluteFolderPath(path.value)) {
    error.value = t('Enter an absolute path to an existing folder.')
    return
  }
  if (props.mode === 'clone') {
    if (!url.value.trim() || !directoryName.value.trim() || /[<>:"/\\|?*\u0000-\u001f]/.test(directoryName.value)
      || ['.', '..'].includes(directoryName.value.trim()) || /[. ]$/.test(directoryName.value)) {
      error.value = t('Enter a repository URL and a new folder name without path separators or reserved characters.')
      return
    }
    await controller.start({ url: url.value.trim(), parentPath: path.value.trim(), directoryName: directoryName.value.trim() })
    return
  }
  busy.value = true
  const current = new AbortController()
  request = current
  try {
    const folder = await props.client.selectDirectory(nodeId.value, path.value.trim(), current.signal)
    if (current.signal.aborted) return
    emit('registered', folder)
    emit('close')
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not open this folder. Check its path and retry.')
  } finally {
    if (request === current) { request = undefined; busy.value = false }
  }
}

async function close() {
  if (cloneView.value.state === 'cancelling') return
  if (cloneActive.value) {
    await controller.cancel()
    if (cloneView.value.state === 'unknown' || cloneView.value.state === 'failed') return
  }
  emit('close')
}

function resetClone() {
  controller.reset()
  url.value = ''
  path.value = ''
  directoryName.value = ''
  directoryEdited.value = false
  error.value = ''
  void nextTick(() => urlInput.value?.focus({ preventScroll: true }))
}

function dialogKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void close(); return }
  if (event.key !== 'Tab') return
  const elements = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]') ?? [])
  const first = elements[0]
  const last = elements.at(-1)
  if (!first) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function deactivate() {
  deactivated = true
  request?.abort()
  busy.value = false
  void controller.cancel()
}
onDeactivated(deactivate)
onUnmounted(deactivate)
</script>

<style scoped>
.folder-dialog-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 36%); }
.folder-dialog { width: min(100%, 480px); min-width: 0; max-height: calc(100dvh - 40px); overflow-y: auto; overscroll-behavior: contain; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.folder-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.folder-dialog h2 { margin: 0; font-size: 18px; font-weight: 600; }
.dialog-intro { margin: 12px 0 24px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
.dialog-field { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; font-size: 13px; font-weight: 500; }
.dialog-field input { min-width: 0; width: 100%; border: 1px solid var(--c-border-soft); border-radius: var(--radius-control); padding: 9px 10px; background: var(--c-bg-input); color: var(--c-text); font: inherit; font-weight: 400; }
.dialog-field input::placeholder { color: var(--c-text-secondary); }
.dialog-field small { color: var(--c-text-secondary); font-weight: 400; line-height: 1.5; }
.path-input-row { display: flex; gap: 8px; }
.path-input-row .btn { flex-shrink: 0; }
.folder-dialog footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.folder-dialog .primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.folder-dialog .primary:hover { background: var(--c-primary-bg-hover); }
.folder-icon-button { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font-size: 22px; }
.folder-icon-button:hover { background: var(--c-bg-muted); color: var(--c-text); }
.folder-dialog :is(button, input, select):focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.folder-dialog button:disabled, .folder-dialog input:disabled { opacity: .6; cursor: not-allowed; }
.destination-preview, .checkout-path { overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
.destination-preview { display: flex; flex-direction: column; gap: 4px; margin: 16px 0 0; }
.clone-status { margin-top: 20px; font-size: 13px; line-height: 1.6; }
.clone-status p { margin: 6px 0 0; color: var(--c-text-secondary); }
.folder-error { color: var(--c-error); font-size: 13px; line-height: 1.6; margin: 16px 0 0; overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .folder-dialog-backdrop { padding: 12px; }
  .folder-dialog { padding: 20px 16px; max-height: calc(100dvh - 24px); }
}
</style>

<style scoped>
.directory-browser { border: 1px solid var(--c-border); border-radius: 8px; padding: 10px; }
.directory-location { overflow-wrap: anywhere; font-size: 12px; }
.directory-list { max-height: 220px; overflow: auto; padding: 0; list-style: none; }
.directory-list button { width: 100%; text-align: left; padding: 6px; background: transparent; color: inherit; border: 0; cursor: pointer; }
.directory-list button:hover { background: var(--c-bg-muted); }
.dialog-field select { padding: 8px; background: var(--c-bg-input); color: inherit; border: 1px solid var(--c-border); border-radius: 6px; }
</style>
