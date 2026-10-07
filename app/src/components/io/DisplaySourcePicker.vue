<template>
  <Teleport to="body">
    <dialog ref="dialog" class="display-picker" aria-labelledby="display-picker-title" aria-describedby="display-picker-description" @cancel.prevent="respond(null)">
      <template v-if="state">
        <header>
          <h2 id="display-picker-title">{{ t('Choose a screen or window') }}</h2>
          <p id="display-picker-description">{{ t('Only the source you share goes to this capture and its confirmed outputs. System audio is not shared.') }}</p>
        </header>
        <div class="picker-content" :aria-busy="state.status === 'loading'">
          <p v-if="state.status === 'loading'" class="picker-message" role="status">{{ t('Loading screen and window previews…') }}</p>
          <p v-else-if="state.status === 'error'" class="picker-message" role="alert">{{ t('Could not load screens and windows. Cancel and try again. If this continues, check screen recording access in your system settings.') }}</p>
          <p v-else-if="!state.sources.length" class="picker-message" role="status">{{ t('No screens or windows are available. Open the window you want to share, then cancel and try again.') }}</p>
          <fieldset v-else :disabled="submitting">
            <legend class="picker-legend">{{ t('Select one source to share') }}</legend>
            <div class="source-grid">
              <label v-for="source in state.sources" :key="source.id" class="source-option" :class="{ selected: selected === source.id }" :title="source.name">
                <span class="source-preview">
                  <img v-if="source.thumbnailUrl && !failedImages.has(source.id)" :src="source.thumbnailUrl" alt="" @error="failedImages.add(source.id)">
                  <span v-else class="preview-unavailable">{{ t('Preview unavailable') }}</span>
                </span>
                <span class="source-caption">
                  <input v-model="selected" type="radio" name="display-source" :value="source.id" :aria-label="`${source.kind === 'screen' ? t('Screen') : t('Window')}: ${source.name}`">
                  <span class="source-text"><span class="source-name">{{ source.name }}</span><span class="source-kind">{{ source.kind === 'screen' ? t('Screen') : t('Window') }}</span></span>
                </span>
              </label>
            </div>
          </fieldset>
          <p v-if="error" class="picker-error" role="alert">{{ error }}</p>
        </div>
        <footer>
          <span class="selection-hint" role="status">{{ selectedName ? t('Selected: {selectedName}', { selectedName: selectedName }) : t('Nothing is shared until you select a source and confirm.') }}</span>
          <div class="picker-actions">
            <button ref="cancelButton" type="button" :disabled="submitting" @click="respond(null)">{{ t('Cancel') }}</button>
            <button type="button" class="share-source" :disabled="!selected || state.status !== 'ready' || submitting" @click="respond(selected)">{{ submitting ? t('Confirming…') : t('Share selected') }}</button>
          </div>
        </footer>
      </template>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import type { DisplayPickerState } from '../../../../desktop/src/media-capture-contract.ts'
import { desktopMediaBridge } from '../../io/desktop.ts'

const dialog = ref<HTMLDialogElement>()
const cancelButton = ref<HTMLButtonElement>()
const state = ref<DisplayPickerState | null>(null)
const selected = ref<string | null>(null)
const failedImages = ref(new Set<string>())
const submitting = ref(false)
const error = ref('')
const selectedName = computed(() => state.value?.sources.find(source => source.id === selected.value)?.name)
const picker = desktopMediaBridge()?.displayPicker
let unsubscribe: (() => void) | undefined
let previousFocus: HTMLElement | null = null
let disposed = false

function close() {
  dialog.value?.close()
  state.value = null
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
async function receive(value: DisplayPickerState | null) {
  if (disposed) return
  if (!value) { close(); return }
  if (state.value?.requestId !== value.requestId) {
    if (!dialog.value?.open) previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    selected.value = null
    failedImages.value = new Set()
    submitting.value = false
    error.value = ''
  }
  state.value = value
  await nextTick()
  if (!disposed && state.value?.requestId === value.requestId && !dialog.value?.open) {
    dialog.value?.showModal()
    cancelButton.value?.focus()
  }
}
async function respond(sourceId: string | null) {
  const requestId = state.value?.requestId
  if (!picker || !requestId || submitting.value) return
  submitting.value = true
  error.value = ''
  try { await picker.respond({ requestId, sourceId }) }
  catch {
    if (state.value?.requestId === requestId) {
      if (sourceId === null) close()
      else error.value = t('This source could not be shared. Select another source or cancel and try again.')
    }
  } finally {
    if (state.value?.requestId === requestId) submitting.value = false
  }
}
onMounted(() => { unsubscribe = picker?.subscribe(value => { void receive(value) }) })
onBeforeUnmount(() => {
  disposed = true
  unsubscribe?.()
  if (state.value) void picker?.respond({ requestId: state.value.requestId, sourceId: null }).catch(() => {})
  close()
})
</script>

<style scoped>
.display-picker { width: min(780px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); margin: auto; padding: 0; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 18px 60px var(--c-shadow); font: inherit; }
.display-picker[open] { display: flex; flex-direction: column; }
.display-picker::backdrop { background: rgb(0 0 0 / 55%); }
header { padding: 24px 24px 18px; border-bottom: 1px solid var(--c-border); }
h2 { margin: 0; font-size: 20px; line-height: 1.3; font-weight: 600; }
header p { margin: 10px 0 0; max-width: 65ch; font-size: 13px; line-height: 1.6; color: var(--c-text-secondary); }
.picker-content { min-height: min(160px, 20dvh); overflow-y: auto; padding: 20px 24px; overscroll-behavior: contain; }
fieldset { margin: 0; padding: 0; border: 0; min-width: 0; }
.picker-legend { margin-bottom: 12px; padding: 0; font-size: 13px; font-weight: 600; }
.source-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.source-option { min-width: 0; border: 1px solid var(--c-border); border-radius: var(--radius-control); overflow: hidden; cursor: pointer; }
.source-option:hover { border-color: var(--c-border-hover); }
.source-option.selected { border-color: var(--c-info); background: var(--c-selection-bg); }
.source-option:focus-within { outline: 2px solid var(--c-info); outline-offset: 3px; }
.source-preview { display: flex; align-items: center; justify-content: center; width: 100%; aspect-ratio: 16 / 9; background: var(--c-bg-muted); }
.source-preview img { display: block; width: 100%; height: 100%; object-fit: contain; }
.preview-unavailable { padding: 12px; color: var(--c-text-secondary); font-size: 13px; }
.source-caption { display: flex; align-items: flex-start; gap: 10px; padding: 12px; }
.source-caption input { flex-shrink: 0; margin: 3px 0 0; accent-color: var(--c-info); }
.source-text { min-width: 0; display: grid; gap: 4px; }
.source-name { font-size: 13px; line-height: 1.4; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.source-kind { color: var(--c-text-secondary); font-size: 12px; }
.picker-message { margin: 12px 0; color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; }
.picker-error { color: var(--c-error); font-size: 13px; line-height: 1.5; }
footer { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 16px; padding: 18px 24px; border-top: 1px solid var(--c-border); }
.selection-hint { flex: 1; min-width: 180px; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.picker-actions { display: flex; gap: 8px; }
button { min-height: 40px; padding: 8px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-card); font: inherit; font-size: 13px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); border-color: var(--c-border-hover); }
button.share-source { background: var(--c-primary-bg); color: var(--c-text-on-primary); border-color: transparent; }
button.share-source:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:focus-visible { outline: 2px solid var(--c-info); outline-offset: 3px; }
button:disabled { opacity: 0.5; cursor: not-allowed; }
@media (max-width: 540px) {
  .display-picker { width: calc(100vw - 24px); max-height: calc(100dvh - 24px); }
  header, .picker-content, footer { padding: 16px; }
  h2 { font-size: 18px; }
  .source-grid { grid-template-columns: minmax(0, 1fr); }
  .picker-actions { width: 100%; }
  .picker-actions button { flex: 1; min-height: 44px; }
}
</style>
