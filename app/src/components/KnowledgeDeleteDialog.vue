<template>
  <Teleport to="body">
    <dialog ref="dialog" class="knowledge-delete" role="alertdialog" aria-modal="true" :aria-labelledby="titleId"
      :aria-describedby="descriptionId" :aria-busy="busy" @cancel.prevent="close" @keydown.stop @keydown.esc.prevent="close">
      <h2 :id="titleId">Delete {{ target.title }}?</h2>
      <p>Project: <strong>{{ projectId }}</strong></p>
      <code>{{ target.path }}</code>
      <p :id="descriptionId">This permanently deletes only this file. Other entries and their references remain unchanged; links to this entry will remain unresolved in the catalog. This cannot be undone.</p>
      <p v-if="target.kind === 'skill'">Only SKILL.md is removed; bundled resources are retained. A built-in skill with the same name becomes available again. Already loaded session instructions are not erased.</p>
      <p v-if="target.path.endsWith('.jsonl')">The entire log file is deleted, including every record in it.</p>
      <h3>{{ incoming.length }} incoming references</h3>
      <ul v-if="incoming.length"><li v-for="(link, index) in incoming" :key="index">{{ link.source }} ({{ link.label }})</li></ul>
      <p v-else>No incoming references in the current knowledge snapshot.</p>
      <p class="muted">New references may be added by running agents. Deleting memory does not erase chat history or prevent future learning from recreating it.</p>
      <p v-if="error" role="alert" class="error">{{ error }}</p>
      <form @submit.prevent="submit">
        <button ref="cancelButton" type="button" :disabled="busy" autofocus @click="close">Cancel</button>
        <button type="submit" class="danger" :disabled="busy">{{ busy ? 'Deleting...' : 'Delete file' }}</button>
      </form>
    </dialog>
  </Teleport>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, useId } from 'vue'
import { createKnowledgeClient, type KnowledgeEntry, type KnowledgeLink } from '../knowledge.ts'
const props = defineProps<{ apiBase: string; projectId: string; target: KnowledgeEntry; incoming: KnowledgeLink[] }>()
const emit = defineEmits<{ close: []; deleted: [id: string] }>()
const target = { ...props.target }
const client = createKnowledgeClient(props.apiBase)
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
    await client.remove(target, lifetime.signal)
    if (!lifetime.signal.aborted) emit('deleted', target.id)
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Deletion was not confirmed. Close and refresh before retrying.'
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
.knowledge-delete { box-sizing: border-box; width: min(560px, calc(100vw - 32px)); max-height: calc(100dvh - 32px); overflow: auto; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); }
.knowledge-delete::backdrop { background: rgb(0 0 0 / 36%); }
h2 { font-size: 18px; margin: 0 0 16px; }
h3 { font-size: 14px; }
p, li, code { font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
ul { max-height: 180px; overflow: auto; padding-left: 20px; }
.muted { color: var(--c-text-secondary); }
.error, .danger { color: var(--c-error); }
form { display: flex; justify-content: flex-end; gap: 8px; margin-top: 20px; }
button { padding: 8px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); cursor: pointer; }
button:disabled { opacity: .5; cursor: not-allowed; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
