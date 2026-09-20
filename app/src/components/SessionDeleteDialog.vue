<template>
  <Teleport to="body">
    <dialog ref="dialog" class="session-delete-dialog" role="alertdialog" aria-modal="true" tabindex="-1"
      :aria-labelledby="titleId" :aria-describedby="descriptionId" :aria-busy="busy || undefined"
      @cancel.prevent="close" @keydown.stop @keydown.esc.prevent="close">
      <h2 :id="titleId">Delete conversation?</h2>
      <p class="delete-target"><strong>{{ target.name }}</strong><span>{{ target.sessionId }}</span></p>
      <p v-if="target.projectName" class="delete-project">Project: {{ target.projectName }}</p>
      <p :id="descriptionId">This conversation and its delegated tasks and calls will be deleted, including their execution history. Active work will be stopped. Independent topics are kept; shared history may be retained to protect other conversations. This cannot be undone.</p>
      <p v-if="error" class="delete-error" role="alert">{{ error }}</p>
      <form @submit.prevent="submit">
        <button ref="cancelButton" type="button" class="delete-button" :disabled="busy" autofocus @click="close">Cancel</button>
        <button type="submit" class="delete-button delete-confirm" :disabled="busy">{{ busy ? 'Deleting...' : 'Delete conversation' }}</button>
      </form>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { nextTick, onDeactivated, onMounted, onUnmounted, ref, useId } from 'vue'
import { deleteConversation, type SessionDeletionTarget } from '../session-deletion.ts'

const props = defineProps<{ target: SessionDeletionTarget }>()
const emit = defineEmits<{ close: []; deleted: [ids: string[]] }>()
const target = { ...props.target }
const titleId = useId()
const descriptionId = useId()
const dialog = ref<HTMLDialogElement>()
const cancelButton = ref<HTMLButtonElement>()
const busy = ref(false)
const error = ref('')
const lifetime = new AbortController()
let returnFocus: HTMLElement | null = null
let fallbackFocus: HTMLElement | null = null
let deleted = false

function close() { if (!busy.value) emit('close') }
async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  await nextTick()
  dialog.value?.focus()
  try {
    const ids = await deleteConversation(target, AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]))
    if (!lifetime.signal.aborted) { deleted = true; emit('deleted', ids) }
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = cause instanceof Error
      ? cause.message : 'Deletion was not confirmed. Check Main and refresh the conversation list before retrying.'
  } finally {
    busy.value = false
    if (!lifetime.signal.aborted && error.value) {
      await nextTick()
      cancelButton.value?.focus()
    }
  }
}
onMounted(() => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  fallbackFocus = returnFocus?.closest('aside')?.querySelector<HTMLElement>('.folders-header button:not(:disabled), .folders-header a[href]') ?? null
  dialog.value?.showModal()
  cancelButton.value?.focus()
})
onDeactivated(() => { dialog.value?.close(); emit('close') })
onUnmounted(() => {
  lifetime.abort()
  dialog.value?.close()
  const focus = !deleted && returnFocus?.isConnected ? returnFocus : fallbackFocus
  if (focus?.isConnected && focus.getClientRects().length) focus.focus({ preventScroll: true })
})
</script>

<style scoped>
.session-delete-dialog { box-sizing: border-box; width: min(480px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow-y: auto; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.session-delete-dialog::backdrop { background: rgb(0 0 0 / 36%); }
h2 { margin: 0 0 20px; font-size: 18px; font-weight: 600; }
p { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.delete-target { display: grid; gap: 4px; margin: 0 0 16px; }
.delete-target span, .delete-project { color: var(--c-text-secondary); }
.delete-error { color: var(--c-error); }
form { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.delete-button { min-height: 36px; padding: 7px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.delete-button:hover:not(:disabled) { background: var(--c-bg-muted); }
.delete-button:disabled { opacity: .5; cursor: not-allowed; }
.delete-confirm { color: var(--c-error); border-color: var(--c-error); }
.delete-button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 480px) { .session-delete-dialog { padding: 20px 16px; } }
</style>
