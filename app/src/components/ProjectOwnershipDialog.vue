<template>
  <Teleport to="body">
    <div class="ownership-backdrop" @click.self="close" @keydown="keydown">
      <section ref="dialog" class="ownership-dialog" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="descriptionId" tabindex="-1">
        <h2 :id="titleId">{{ action === 'move' ? 'Move folder to another organization' : 'Remove folder from organization' }}</h2>
        <p class="ownership-folder"><strong>{{ project.name }}</strong><span>{{ project.path }}</span></p>
        <p :id="descriptionId">Files on disk will not be moved or deleted. Existing conversations and learned memory stay in {{ organization.name }}. Those conversations will no longer be able to use this folder.</p>
        <form @submit.prevent="submit">
          <label v-if="action === 'move'" class="ownership-field">
            Destination organization
            <select v-model="targetId" :disabled="busy" required>
              <option value="" disabled>Choose an organization</option>
              <option v-for="target in targets" :key="target.id" :value="target.id">{{ target.name }}{{ duplicateName(target.name) ? ` (${target.id.slice(0, 8)})` : '' }}</option>
            </select>
          </label>
          <p v-if="action === 'move' && !targets.length" class="ownership-note">Create another organization before moving this folder.</p>
          <p class="ownership-note">Stop active work in this organization before continuing. Unconfirmed remote jobs or overlapping folders may also prevent this change.</p>
          <p v-if="error" class="ownership-error" role="alert">{{ error }}</p>
          <footer>
            <button v-if="error" type="button" class="btn" :disabled="busy" @click="$emit('refresh')">Refresh folders</button>
            <button ref="cancelButton" type="button" class="btn" :disabled="busy" @click="close">Cancel</button>
            <button type="submit" class="btn ownership-confirm" :disabled="busy || (action === 'move' && !targetId)">
              {{ busy ? 'Updating...' : action === 'move' ? 'Move folder' : 'Remove folder' }}
            </button>
          </footer>
        </form>
      </section>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId } from 'vue'
import { createProjectsClient, type ProjectRecord } from '../projects-client.ts'
import type { OrganizationRecord } from '../organizations.ts'
import { organizationBase } from '../api-url.ts'

const props = defineProps<{
  apiBase: string; organization: OrganizationRecord; organizations: OrganizationRecord[]
  project: ProjectRecord; action: 'remove' | 'move'
}>()
const emit = defineEmits<{ close: []; refresh: []; changed: [project?: ProjectRecord] }>()
const titleId = useId()
const descriptionId = useId()
const dialog = ref<HTMLElement>()
const cancelButton = ref<HTMLButtonElement>()
const targetId = ref('')
const busy = ref(false)
const error = ref('')
const targets = computed(() => props.organizations.filter(org => org.id !== props.organization.id))
const duplicateName = (name: string) => targets.value.filter(org => org.name === name).length > 1
const lifetime = new AbortController()
let returnFocus: HTMLElement | null = null
function close() { if (!busy.value) emit('close') }
async function submit() {
  if (busy.value || (props.action === 'move' && !targets.value.some(org => org.id === targetId.value))) return
  busy.value = true
  error.value = ''
  try {
    const client = createProjectsClient(organizationBase(props.apiBase, props.organization.id))
    const result = props.action === 'move'
      ? await client.move(props.project.id, targetId.value, lifetime.signal)
      : await client.remove(props.project.id, lifetime.signal)
    if (!lifetime.signal.aborted) emit('changed', result || undefined)
  } catch (cause) {
    if (!lifetime.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not update folder ownership. Refresh and retry.'
  } finally { busy.value = false }
}
function keydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return }
  if (event.key !== 'Tab') return
  const controls = [...(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled)') ?? [])]
  const first = controls[0], last = controls.at(-1)
  if (!first) { event.preventDefault(); dialog.value?.focus(); return }
  if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog.value)) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
}
onMounted(async () => {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
  await nextTick()
  cancelButton.value?.focus()
})
onUnmounted(() => {
  lifetime.abort()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
})
</script>

<style scoped>
.ownership-backdrop { position: fixed; inset: 0; z-index: 1000; display: grid; place-items: center; padding: 20px; background: rgb(0 0 0 / 36%); }
.ownership-dialog { width: min(100%, 480px); min-width: 0; max-height: calc(100dvh - 40px); overflow-y: auto; padding: 24px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 16px 48px var(--c-shadow); }
.ownership-dialog h2 { margin: 0; font-size: 18px; font-weight: 600; }
.ownership-dialog p { font-size: 13px; line-height: 1.6; }
.ownership-folder { display: grid; gap: 4px; margin: 20px 0; overflow-wrap: anywhere; }
.ownership-folder span, .ownership-note { color: var(--c-text-secondary); }
.ownership-field { display: grid; gap: 8px; margin-top: 20px; font-size: 13px; }
.ownership-field select { width: 100%; min-width: 0; padding: 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); font: inherit; background: var(--c-bg-input); color: var(--c-text); }
.ownership-dialog footer { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; margin-top: 24px; }
.btn { min-height: 36px; padding: 7px 14px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.btn:hover:not(:disabled) { background: var(--c-bg-muted); }
.btn:disabled { opacity: .5; cursor: not-allowed; }
.ownership-confirm { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.ownership-confirm:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.ownership-error { color: var(--c-error); overflow-wrap: anywhere; }
.ownership-dialog :is(button, select):focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 480px) { .ownership-backdrop { padding: 12px; } .ownership-dialog { padding: 20px 16px; } }
</style>
