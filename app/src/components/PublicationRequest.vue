<template>
  <section v-if="enabled && (request || error || notice)" class="publication-request" aria-label="Agent publication approval">
    <template v-if="request">
      <label v-if="requests.length > 1" class="publication-picker">Review ({{ requests.length }})
        <select v-model="selectedId" :disabled="busy">
          <option v-for="item in requests" :key="item.id" :value="item.id">{{ item.change?.title || 'Agent configuration' }} · {{ item.id }}</option>
        </select>
      </label>
      <h3>{{ request.change?.title || 'Publish agent configuration?' }}</h3>
      <p>Publish these changes together for the affected conversations. Nothing is published until you approve.</p>
      <p class="publication-summary">{{ request.files.length }} changed files · {{ request.impact ? `${request.impact.affectedBindings.length} affected conversations` : 'Review conversation changes below' }}</p>
      <p>{{ request.impact ? (request.impact.permissionsChanged ? 'Permissions change — review access below.' : 'No permission changes.') : 'Permission impact is not summarized — review bindings below.' }}</p>
      <p v-if="request.status === 'waiting'" role="status">Approved; waiting for active conversations to finish. No further approval is needed.</p>
      <p v-if="request.status === 'error'" class="publication-error" role="alert">Publication failed. {{ request.error?.message }} Cancel this review and request a new one after correcting the problem.</p>
      <div class="publication-review">
        <details v-if="request.impact?.affectedBindings.length">
          <summary>Affected conversations ({{ request.impact.affectedBindings.length }})</summary>
          <ul><li v-for="binding in request.impact.affectedBindings" :key="binding">{{ binding }}</li></ul>
        </details>
        <details>
          <summary>Checks for this revision ({{ checks.length }})</summary>
          <p v-if="!checks.length">No checks are recorded for this exact revision.</p>
          <ul v-else><li v-for="check in checks" :key="check.id">{{ checkLabel(check.kind) }} — {{ check.status }}</li></ul>
          <p>Preview only assembles prompts. Tool tests and model scenarios use synthetic tools; a controlled probe contacts a service. These checks do not establish full business acceptance.</p>
        </details>
        <details>
          <summary>Review conversations and permissions</summary>
          <h4>Proposed bindings</h4>
          <pre>{{ JSON.stringify(request.bindings, null, 2) }}</pre>
          <h4>Current bindings</h4>
          <pre>{{ JSON.stringify(request.previousBindings, null, 2) }}</pre>
        </details>
        <details v-for="file in request.files" :key="file.path">
          <summary>{{ file.before === null ? 'Add' : file.after === null ? 'Remove' : 'Change' }} {{ file.path }}</summary>
          <template v-if="file.after !== null"><h4>Proposed</h4><pre>{{ file.after }}</pre></template>
          <template v-if="file.before !== null"><h4>Current</h4><pre>{{ file.before }}</pre></template>
        </details>
        <details>
          <summary>Exact revisions</summary>
          <p>{{ request.change ? 'Candidate' : 'Draft' }}: <code>{{ request.revision }}</code></p>
          <p>Published base: <code>{{ request.baseRevision }}</code></p>
        </details>
      </div>
      <div class="publication-actions">
        <button type="button" :disabled="busy || needsReload" @click="cancel">{{ operation === 'cancelling' ? 'Cancelling…' : 'Cancel publication' }}</button>
        <button type="button" class="publication-confirm" :disabled="busy || needsReload || !!request.status" @click="confirm">{{ operation === 'publishing' ? 'Publishing…' : request.status === 'waiting' ? 'Approval recorded' : 'Approve publication' }}</button>
      </div>
    </template>
    <p v-if="notice" class="publication-notice" role="status">{{ notice }}</p>
    <p v-if="error" class="publication-error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" :disabled="busy || loading" @click="reload">{{ loading ? 'Reloading…' : 'Reload review' }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { usePublicationRequest } from '../publication-requests.ts'

const props = defineProps<{
  apiBase: string; projectId: string; sessionId: string; active: boolean; canSubmit: boolean; stage?: string | null
}>()
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const active = computed(() => props.active && documentVisible.value)
const { request, requests, selectedId, error, notice, loading, operation, busy, enabled, needsReload, confirm, cancel, reload } =
  usePublicationRequest(() => ({ ...props, active: active.value }))
const checks = computed(() => request.value?.checks?.filter(check => check.revision === request.value?.revision) ?? [])
function checkLabel(kind: string) {
  if (kind === 'preview') return 'Prompt preview (not a behavior evaluation)'
  if (kind === 'validate') return 'Configuration validation'
  if (kind === 'test') return 'Synthetic tool test (not a live integration test)'
  if (kind === 'scenario') return 'Simulated agent scenario (not full acceptance)'
  if (kind === 'synthetic' || kind === 'check') return 'Synthetic configuration check'
  if (kind === 'probe') return 'Controlled connection probe (not full acceptance)'
  return kind
}
function visibility() { documentVisible.value = document.visibilityState !== 'hidden' }
onMounted(() => document.addEventListener('visibilitychange', visibility))
onUnmounted(() => document.removeEventListener('visibilitychange', visibility))
</script>

<style scoped>
.publication-request { box-sizing: border-box; flex: 0 1 auto; min-height: 0; width: calc(100% - 40px); max-width: 860px; max-height: min(48dvh, 460px); overflow-y: auto; overscroll-behavior: contain; margin: 8px auto 0; padding: 14px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
p { margin: 8px 0; }
.publication-summary { color: var(--c-text-secondary); }
.publication-picker { display: block; margin-bottom: 12px; color: var(--c-text-secondary); }
select { display: block; box-sizing: border-box; width: 100%; min-height: 34px; margin-top: 4px; padding: 6px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text); font: inherit; }
.publication-review { max-height: 22dvh; overflow-y: auto; overscroll-behavior: contain; }
details { padding-block: 5px; }
summary { cursor: pointer; }
h4 { margin: 10px 0 4px; font-size: 12px; color: var(--c-text-secondary); }
pre { margin: 0; padding: 8px; background: var(--c-bg-muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.publication-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 12px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .5; cursor: not-allowed; }
.publication-confirm { margin-inline-start: auto; background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.publication-confirm:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:focus-visible, summary:focus-visible, select:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.publication-error { color: var(--c-error); }
.publication-notice { margin: 0; }
@media (max-width: 600px) { .publication-request { width: calc(100% - 24px); padding: 12px; } }
</style>
