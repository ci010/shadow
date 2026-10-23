<template>
  <Teleport to="body">
    <dialog ref="dialog" class="project-delete-dialog" role="alertdialog" aria-modal="true" tabindex="-1"
      :aria-labelledby="titleId" :aria-describedby="descriptionId" :aria-busy="busy || undefined"
      @cancel.prevent="close" @keydown.stop @keydown.esc.prevent="close">
      <h2 :id="titleId">{{ t('Delete project?') }}</h2>
      <p class="delete-target"><strong>{{ project.name }}</strong></p>
      <p :id="descriptionId">{{ t('This permanently deletes the project\'s Home, conversations, memory, skills, bots, automations and settings. Registered working folders and their files are kept. Stop active work before deleting. This cannot be undone.') }}</p>
      <form @submit.prevent="submit">
        <label>{{ t('To confirm, enter the following name:') }} <strong>{{ project.name }}</strong>
          <input v-model="confirmation" autocomplete="off" :disabled="busy" />
        </label>
        <p v-if="error" class="delete-error" role="alert">{{ error }}</p>
        <div class="delete-actions">
          <button ref="cancelButton" type="button" class="delete-button" :disabled="busy" autofocus @click="close">{{ t('Cancel') }}</button>
          <button type="submit" class="delete-button delete-confirm" :disabled="busy || confirmation !== project.name">{{ busy ? t('Deleting...') : t('Delete project') }}</button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { nextTick, onDeactivated, onMounted, onUnmounted, ref, useId } from 'vue'
import { createProjectsClient, type ProjectRecord } from '../projects.ts'

const props = defineProps<{ apiBase: string; project: ProjectRecord }>()
const emit = defineEmits<{ close: []; deleted: [id: string] }>()
const project = { ...props.project }
const titleId = useId(), descriptionId = useId()
const dialog = ref<HTMLDialogElement>(), cancelButton = ref<HTMLButtonElement>()
const confirmation = ref(''), busy = ref(false), error = ref('')
const lifetime = new AbortController()
let returnFocus: HTMLElement | null = null
function close() { if (!busy.value) emit('close') }
async function submit() {
  if (busy.value || confirmation.value !== project.name) return
  busy.value = true
  error.value = ''
  await nextTick()
  dialog.value?.focus()
  try {
    await createProjectsClient(props.apiBase).remove(project.id, lifetime.signal)
    if (!lifetime.signal.aborted) emit('deleted', project.id)
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = cause instanceof Error ? cause.message
      : t('Deletion was not confirmed. Refresh the catalog before retrying.')
  } finally {
    busy.value = false
    if (!lifetime.signal.aborted && error.value) { await nextTick(); cancelButton.value?.focus() }
  }
}
onMounted(() => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  cancelButton.value?.focus()
})
onDeactivated(() => { dialog.value?.close(); emit('close') })
onUnmounted(() => {
  lifetime.abort()
  dialog.value?.close()
  if (returnFocus?.isConnected && returnFocus.getClientRects().length) returnFocus.focus({ preventScroll: true })
})
</script>

<style scoped>
.project-delete-dialog { box-sizing: border-box; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.project-delete-dialog::backdrop { background: rgb(0 0 0 / 36%); }
h2 { margin: 0 0 20px; font-size: 16px; font-weight: 600; }
p, label { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.delete-target { margin: 0 0 16px; }
label { display: grid; gap: 8px; margin-top: 20px; }
input { box-sizing: border-box; width: 100%; min-height: 36px; padding: 8px; border: 1px solid var(--c-control-border); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
.delete-error { color: var(--c-error); }
.delete-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.delete-button { min-height: 36px; padding: 7px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.delete-button:hover:not(:disabled) { background: var(--c-bg-muted); }
.delete-button:disabled { opacity: .5; cursor: not-allowed; }
.delete-confirm { color: var(--c-error); border-color: var(--c-error); }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px), (pointer: coarse) { .delete-button { min-height: 44px; } }
</style>
