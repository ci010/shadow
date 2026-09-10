<template>
  <Teleport to="body">
    <div v-if="mode" class="project-dialog-backdrop" @click.self="close" @keydown="dialogKeydown">
      <section ref="dialog" class="project-dialog" role="dialog" aria-modal="true" aria-labelledby="project-dialog-title" tabindex="-1">
        <header>
          <h2 id="project-dialog-title">{{ mode === 'open' ? 'Open folder' : 'Clone repo' }}</h2>
          <button class="project-icon-button" aria-label="Close project dialog" :disabled="busy || cloneView.state === 'cancelling'" @click="close">×</button>
        </header>
        <p class="dialog-intro">{{ mode === 'open' ? 'Use an existing folder as a project. Your files stay where they are.' : 'Clone a repository into a new folder on this computer.' }}</p>
        <form @submit.prevent="submit">
          <label v-if="mode === 'clone'" class="dialog-field">
            <span>Repository URL</span>
            <input ref="urlInput" v-model="url" type="text" autocomplete="off" spellcheck="false" placeholder="https://github.com/owner/repo.git" :disabled="cloneActive" required />
            <small>HTTPS or SSH. Use Git authentication rather than a token in the URL.</small>
          </label>
          <label class="dialog-field">
            <span>{{ mode === 'open' ? 'Folder path' : 'Parent folder' }}</span>
            <span class="path-input-row">
              <input ref="pathInput" v-model="path" type="text" autocomplete="off" spellcheck="false" placeholder="Absolute folder path" :disabled="busy || cloneActive" required />
              <button v-if="hasPicker" type="button" class="btn" :disabled="busy || cloneActive" @click="chooseDirectory(false)">{{ busy ? 'Choosing…' : 'Browse…' }}</button>
            </span>
            <small>{{ hasPicker ? 'Choose an existing folder on this computer.' : 'Enter an absolute path on the computer running Main.' }}</small>
          </label>
          <label v-if="mode === 'clone'" class="dialog-field">
            <span>New folder name</span>
            <input v-model="directoryName" type="text" autocomplete="off" spellcheck="false" :disabled="cloneActive" @input="directoryEdited = true" required />
          </label>
          <p v-if="mode === 'clone' && path && directoryName" class="destination-preview"><span>Destination</span><span>{{ destination }}</span></p>
          <div v-if="mode === 'clone' && cloneView.state !== 'idle'" class="clone-status" aria-live="polite">
            <strong>{{ cloneStatus }}</strong>
            <p v-if="cloneView.state === 'running' || cloneView.state === 'starting'">You can cancel while the repository is being downloaded.</p>
            <p v-if="cloneView.state === 'succeeded'">The folder is ready in Projects. Use its + button to start a conversation.</p>
            <p v-if="cloneView.state === 'failed' || cloneView.state === 'cancelled' || cloneView.state === 'unknown'">Any partial checkout is kept on disk; it is not deleted automatically.</p>
            <p v-if="cloneView.operation?.destination" class="checkout-path">{{ cloneView.operation.destination }}</p>
          </div>
          <p v-if="error || (mode === 'clone' && cloneView.error)" class="project-error" role="alert">{{ error || cloneView.error }}</p>
          <footer>
            <template v-if="mode === 'clone' && cloneActive">
              <button v-if="cloneView.state === 'unknown'" class="btn" type="button" @click="controller.refresh()">Retry status</button>
              <button class="btn" type="button" :disabled="cloneView.state === 'cancelling'" @click="controller.cancel()">{{ cloneView.state === 'cancelling' ? 'Cancelling…' : 'Cancel clone' }}</button>
            </template>
            <template v-else>
              <button class="btn" type="button" :disabled="busy" @click="close">{{ cloneView.state === 'succeeded' && mode === 'clone' ? 'Done' : 'Cancel' }}</button>
              <button v-if="mode === 'clone' && cloneView.state === 'succeeded'" class="btn" type="button" @click="resetClone">Clone another repository</button>
              <button v-if="mode === 'open' || cloneView.state !== 'succeeded'" class="btn primary" type="submit" :disabled="busy">{{ busy ? 'Opening…' : mode === 'open' ? 'Open folder' : cloneView.state === 'idle' ? 'Clone repo' : 'Retry clone' }}</button>
            </template>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { createCloneController, type CloneView, type ProjectRecord, type ProjectsClient } from '../projects-client.ts'
import { isAbsoluteProjectPath, suggestCloneDirectory } from '../projects-sidebar.ts'

const props = defineProps<{ mode: 'open' | 'clone' | null; client: ProjectsClient }>()
const emit = defineEmits<{
  close: []
  registered: [project: ProjectRecord]
  status: [view: CloneView]
}>()
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
const hasPicker = computed(() => !!window.shadowDesktop?.projects?.selectDirectory)
const cloneActive = computed(() => props.mode === 'clone' && ['starting', 'running', 'cancelling', 'unknown'].includes(cloneView.value.state))
const destination = computed(() => `${path.value.replace(/[\\/]+$/, '')}${path.value.includes('\\') ? '\\' : '/'}${directoryName.value}`)
const cloneStatus = computed(() => ({
  idle: '', starting: 'Starting clone…', running: 'Cloning repository…', cancelling: 'Cancelling clone…',
  succeeded: 'Repository cloned', failed: 'Clone failed', cancelled: 'Clone cancelled', unknown: 'Clone status unavailable',
})[cloneView.value.state])
let request: AbortController | undefined
let pickerGeneration = 0
let returnFocus: HTMLElement | null = null
let deactivated = false

const controller = createCloneController(props.client, view => {
  cloneView.value = view
  emit('status', view)
  if (view.state === 'succeeded' && view.operation?.project) emit('registered', view.operation.project)
})

watch(url, value => {
  if (!directoryEdited.value) directoryName.value = suggestCloneDirectory(value)
})
watch(() => props.mode, async (mode, previous) => {
  error.value = ''
  if (!mode) {
    pickerGeneration++
    request?.abort()
    busy.value = false
    if (!deactivated && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
    return
  }
  deactivated = false
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  if (mode === 'open' && previous !== 'open') path.value = ''
  await nextTick()
  ;(mode === 'clone' ? urlInput.value : pathInput.value)?.focus({ preventScroll: true })
  if (mode === 'open' && hasPicker.value) await chooseDirectory(true)
})

async function chooseDirectory(openImmediately: boolean) {
  if (busy.value) return
  const picker = window.shadowDesktop?.projects
  if (!picker?.selectDirectory) return
  const current = ++pickerGeneration
  busy.value = true
  error.value = ''
  try {
    const selected = await picker.selectDirectory()
    if (current !== pickerGeneration) return
    if (selected === null) {
      if (openImmediately) emit('close')
      return
    }
    if (typeof selected !== 'string' || !isAbsoluteProjectPath(selected)) throw new Error('invalid selection')
    path.value = selected
    if (openImmediately) {
      busy.value = false
      await submit()
    }
  } catch {
    if (current === pickerGeneration) error.value = 'The folder picker could not open. Try Browse again, or enter an existing absolute folder path.'
  } finally {
    if (current === pickerGeneration) busy.value = false
  }
}

async function submit() {
  if (busy.value || cloneActive.value) return
  error.value = ''
  if (!isAbsoluteProjectPath(path.value)) {
    error.value = 'Enter an absolute path to an existing folder.'
    return
  }
  if (props.mode === 'clone') {
    if (!url.value.trim() || !directoryName.value.trim() || /[<>:"/\\|?*\u0000-\u001f]/.test(directoryName.value)
      || ['.', '..'].includes(directoryName.value.trim()) || /[. ]$/.test(directoryName.value)) {
      error.value = 'Enter a repository URL and a new folder name without path separators or reserved characters.'
      return
    }
    await controller.start({ url: url.value.trim(), parentPath: path.value.trim(), directoryName: directoryName.value.trim() })
    return
  }
  busy.value = true
  const current = new AbortController()
  request = current
  try {
    const project = await props.client.register(path.value.trim(), current.signal)
    if (current.signal.aborted) return
    emit('registered', project)
    emit('close')
  } catch (cause) {
    if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not open this folder. Check its path and retry.'
  } finally {
    if (request === current) { request = undefined; busy.value = false }
  }
}

async function close() {
  if (busy.value || cloneView.value.state === 'cancelling') return
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
  const elements = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), [tabindex="0"]') ?? [])
  const first = elements[0]
  const last = elements.at(-1)
  if (!first) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
function deactivate() {
  deactivated = true
  pickerGeneration++
  request?.abort()
  busy.value = false
  void controller.cancel()
}
onDeactivated(deactivate)
onUnmounted(deactivate)
</script>

<style scoped>
.project-dialog-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 36%); }
.project-dialog { width: min(100%, 480px); min-width: 0; max-height: calc(100dvh - 40px); overflow-y: auto; overscroll-behavior: contain; padding: 24px; border: 1px solid var(--c-border); border-radius: 10px; background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.project-dialog header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.project-dialog h2 { margin: 0; font-size: 18px; font-weight: 600; }
.dialog-intro { margin: 12px 0 24px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
.dialog-field { display: flex; flex-direction: column; gap: 8px; margin-top: 18px; font-size: 13px; font-weight: 500; }
.dialog-field input { min-width: 0; width: 100%; border: 1px solid var(--c-border-soft); border-radius: 5px; padding: 9px 10px; background: var(--c-bg-input); color: var(--c-text); font: inherit; font-weight: 400; }
.dialog-field input::placeholder { color: var(--c-text-secondary); }
.dialog-field small { color: var(--c-text-secondary); font-weight: 400; line-height: 1.5; }
.path-input-row { display: flex; gap: 8px; }
.path-input-row .btn { flex-shrink: 0; }
.project-dialog footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.project-dialog .primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.project-dialog .primary:hover { background: var(--c-primary-bg-hover); }
.project-icon-button { display: grid; place-items: center; flex-shrink: 0; width: 32px; height: 32px; border: 0; border-radius: 4px; background: transparent; color: var(--c-text-secondary); font-size: 22px; }
.project-icon-button:hover { background: var(--c-bg-muted); color: var(--c-text); }
.project-dialog :is(button, input):focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.project-dialog button:disabled, .project-dialog input:disabled { opacity: .6; cursor: not-allowed; }
.destination-preview, .checkout-path { overflow-wrap: anywhere; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
.destination-preview { display: flex; flex-direction: column; gap: 4px; margin: 16px 0 0; }
.clone-status { margin-top: 20px; font-size: 13px; line-height: 1.6; }
.clone-status p { margin: 6px 0 0; color: var(--c-text-secondary); }
.project-error { color: var(--c-error); font-size: 13px; line-height: 1.6; margin: 16px 0 0; overflow-wrap: anywhere; }
@media (max-width: 480px) {
  .project-dialog-backdrop { padding: 12px; }
  .project-dialog { padding: 20px 16px; max-height: calc(100dvh - 24px); }
}
</style>
