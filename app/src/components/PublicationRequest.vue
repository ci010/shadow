<template>
  <section v-if="enabled && (request || error || notice)" class="publication-request" :aria-label="t('Agent publication approval')">
    <template v-if="request">
      <label v-if="requests.length > 1" class="publication-picker">{{ t('Review (') }}{{ requests.length }})
        <UiSelect v-model="selectedId" :disabled="busy">
          <option v-for="item in requests" :key="item.id" :value="item.id">{{ item.change?.title || t('Agent configuration') }} · {{ item.id }}</option>
        </UiSelect>
      </label>
      <h3>{{ request.change?.title || t('Publish agent configuration?') }}</h3>
      <p>{{ t('Publish these changes together for the affected conversations. Nothing is published until you approve.') }}</p>
      <p class="publication-summary">{{ request.files.length }} {{ t('changed files ·') }} {{ request.impact ? t('{length} affected conversations', { length: request.impact.affectedBindings.length }) : t('Review conversation changes below') }}</p>
      <p>{{ request.impact ? (request.impact.permissionsChanged ? t('Permissions change — review access below.') : t('No permission changes.')) : t('Permission impact is not summarized — review bindings below.') }}</p>
      <p v-if="request.status === 'waiting'" role="status">{{ t('Approved; waiting for active conversations to finish. No further approval is needed.') }}</p>
      <p v-if="request.status === 'error'" class="publication-error" role="alert">{{ t('Publication failed.') }} {{ request.error?.message }} {{ t('Cancel this review and request a new one after correcting the problem.') }}</p>
      <div class="publication-review">
        <details v-if="request.impact?.affectedBindings.length">
          <summary>{{ t('Affected conversations (') }}{{ request.impact.affectedBindings.length }})</summary>
          <ul><li v-for="binding in request.impact.affectedBindings" :key="binding">{{ binding }}</li></ul>
        </details>
        <details>
          <summary>{{ t('Checks for this revision (') }}{{ checks.length }})</summary>
          <p v-if="!checks.length">{{ t('No checks are recorded for this exact revision.') }}</p>
          <ul v-else><li v-for="check in checks" :key="check.id">{{ checkLabel(check.kind) }} — {{ enumLabel(check.status) }}</li></ul>
          <p>{{ t('Preview only assembles prompts. Tool tests and model scenarios use synthetic tools; a controlled probe contacts a service. These checks do not establish full business acceptance.') }}</p>
        </details>
        <details>
          <summary>{{ t('Review conversations and permissions') }}</summary>
          <h4>{{ t('Proposed bindings') }}</h4>
          <pre>{{ JSON.stringify(request.bindings, null, 2) }}</pre>
          <h4>{{ t('Current bindings') }}</h4>
          <pre>{{ JSON.stringify(request.previousBindings, null, 2) }}</pre>
        </details>
        <details v-for="file in request.files" :key="file.path">
          <summary>{{ file.before === null ? t('Add') : file.after === null ? t('Remove') : t('Change') }} {{ file.path }}</summary>
          <template v-if="file.after !== null"><h4>{{ t('Proposed') }}</h4><pre>{{ file.after }}</pre></template>
          <template v-if="file.before !== null"><h4>{{ t('Current') }}</h4><pre>{{ file.before }}</pre></template>
        </details>
        <details>
          <summary>{{ t('Exact revisions') }}</summary>
          <p>{{ request.change ? t('Candidate') : t('Draft') }}: <code>{{ request.revision }}</code></p>
          <p>{{ t('Published base:') }} <code>{{ request.baseRevision }}</code></p>
        </details>
      </div>
      <div class="publication-actions">
        <button type="button" :disabled="busy || needsReload" @click="cancel">{{ operation === 'cancelling' ? t('Cancelling…') : t('Cancel publication') }}</button>
        <button type="button" class="publication-confirm" :disabled="busy || needsReload || !!request.status" @click="confirm">{{ operation === 'publishing' ? t('Publishing…') : request.status === 'waiting' ? t('Approval recorded') : t('Approve publication') }}</button>
      </div>
    </template>
    <p v-if="notice" class="publication-notice" role="status">{{ notice }}</p>
    <p v-if="error" class="publication-error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" :disabled="busy || loading" @click="reload">{{ loading ? t('Reloading…') : t('Reload review') }}</button>
  </section>
</template>

<script setup lang="ts">
import UiSelect from './UiSelect.vue'
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
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
  if (kind === 'preview') return t('Prompt preview (not a behavior evaluation)')
  if (kind === 'validate') return t('Configuration validation')
  if (kind === 'test') return t('Synthetic tool test (not a live integration test)')
  if (kind === 'scenario') return t('Simulated agent scenario (not full acceptance)')
  if (kind === 'synthetic' || kind === 'check') return t('Synthetic configuration check')
  if (kind === 'probe') return t('Controlled connection probe (not full acceptance)')
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
.ui-select { display: flex; box-sizing: border-box; width: 100%; min-height: 34px; margin-top: 4px; padding: 6px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text); font: inherit; }
.publication-review { max-height: 22dvh; overflow-y: auto; overscroll-behavior: contain; }
details { padding-block: 5px; }
summary { cursor: pointer; }
h4 { margin: 10px 0 4px; font-size: 12px; color: var(--c-text-secondary); }
pre { margin: 0; padding: 8px; background: var(--c-bg-muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.publication-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button:where(:not(.ui-select)) { min-height: 34px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 12px; cursor: pointer; }
button:where(:not(.ui-select)):hover:not(:disabled) { background: var(--c-bg-muted); }
button:where(:not(.ui-select)):disabled { opacity: .5; cursor: not-allowed; }
.publication-confirm { margin-inline-start: auto; background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.publication-confirm:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:where(:not(.ui-select)):focus-visible, summary:focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.publication-error { color: var(--c-error); }
.publication-notice { margin: 0; }
@media (max-width: 600px) { .publication-request { width: calc(100% - 24px); padding: 12px; } }
</style>
