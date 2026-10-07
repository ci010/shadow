<template>
  <Teleport to="body">
    <dialog ref="dialog" class="repair-dialog" role="alertdialog" aria-modal="true" :aria-labelledby="titleId"
      :aria-describedby="descriptionId" :aria-busy="busy" @cancel.prevent="close" @keydown.stop @keydown.esc.prevent="close">
      <h2 :id="titleId">{{ t('Repair dead links?') }}</h2>
      <p>{{ t('Project:') }} <strong>{{ projectId }}</strong></p><code>{{ preview.sourceId }}</code>
      <p :id="descriptionId">{{ t('Replace') }} {{ preview.findingIds.length }} {{ t('confirmed missing link occurrences in this Wiki file with their label text. No pages are deleted and historical references are not changed.') }}</p>
      <p class="muted">{{ t('The source revision and missing targets are checked again before applying. Newly restored targets or changed files require a fresh scan and preview.') }}</p>
      <div class="comparison">
        <section><h3>{{ t('Before') }}</h3><pre>{{ preview.before }}</pre></section>
        <section><h3>{{ t('After') }}</h3><pre>{{ preview.after }}</pre></section>
      </div>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <form @submit.prevent="submit">
        <button ref="cancelButton" type="button" :disabled="busy" autofocus @click="close">{{ t('Cancel') }}</button>
        <button type="submit" :disabled="busy">{{ busy ? t('Applying...') : t('Confirm repair') }}</button>
      </form>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { onMounted, onUnmounted, ref, useId } from 'vue'
import { createKnowledgeMaintenanceClient, type KnowledgeRepairPreview } from '../knowledge-maintenance.ts'
const props = defineProps<{ apiBase: string; projectId: string; preview: KnowledgeRepairPreview }>()
const emit = defineEmits<{ close: []; applied: [id: string] }>()
const preview = { ...props.preview }
const client = createKnowledgeMaintenanceClient(props.apiBase)
const dialog = ref<HTMLDialogElement>()
const cancelButton = ref<HTMLButtonElement>()
const titleId = useId()
const descriptionId = useId()
const busy = ref(false)
const error = ref('')
const lifetime = new AbortController()
let returnFocus: HTMLElement | null = null
function close() { if (!busy.value) emit('close') }
async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await client.apply(preview, lifetime.signal)
    if (!lifetime.signal.aborted) emit('applied', preview.sourceId)
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Repair was not confirmed. Close and refresh before retrying.')
  } finally { busy.value = false }
}
onMounted(() => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  dialog.value?.showModal()
  cancelButton.value?.focus()
})
onUnmounted(() => {
  lifetime.abort()
  dialog.value?.close()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
})
</script>

<style scoped>
.repair-dialog { box-sizing: border-box; width: min(1050px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); }
.repair-dialog::backdrop { background: rgb(0 0 0 / 36%); }
h2 { font-size: 18px; margin: 0 0 16px; }
h3 { font-size: 13px; }
p, code { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
.muted { color: var(--c-text-secondary); }
.error { color: var(--c-error); }
.comparison { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.comparison section { min-width: 0; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 40vh; overflow: auto; background: var(--c-bg-soft); border: 1px solid var(--c-border); padding: 12px; font-size: 12px; line-height: 1.6; }
form { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
button { padding: 8px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 650px) { .comparison { grid-template-columns: 1fr; } }
</style>
