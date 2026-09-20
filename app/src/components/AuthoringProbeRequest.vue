<template>
  <section v-if="enabled && (request || error || notice)" class="probe-request" aria-label="Connection test approval">
    <template v-if="request">
      <label v-if="requests.length > 1" class="probe-picker">Connection test ({{ requests.length }})
        <select v-model="selectedId" :disabled="busy">
          <option v-for="item in requests" :key="item.id" :value="item.id">{{ item.title }} · {{ item.status }} · {{ item.id }}</option>
        </select>
      </label>
      <h3>{{ request.title }}</h3>
      <p v-if="request.status === 'pending'">Approve one controlled connection test of <strong>{{ request.toolName }}</strong>, including before publication.</p>
      <p v-else role="status">Connection test: {{ request.status }}.</p>
      <p class="probe-summary">{{ request.address.platform }} · {{ request.address.conversationId }} · at most {{ request.maxCalls }} GET calls</p>
      <p>Only the routes below and the pinned tool arguments are authorized for this run. No native network access, writes, inbox delivery or publication.</p>
      <div class="probe-review">
        <ul class="probe-grants">
          <li v-for="grant in request.grants" :key="grant.id">
            <strong>{{ grant.origin }}</strong>
            <ul><li v-for="route in grant.routes" :key="`${route.method} ${route.path}`"><code>{{ route.method }} {{ route.path }}</code></li></ul>
            <p v-if="grant.credential">Credential reference: <code>{{ grant.credential.secretRef }}</code> · header <code>{{ grant.credential.header }}</code><template v-if="grant.credential.prefix"> · prefix <code>{{ grant.credential.prefix }}</code></template> (no secret value shown)</p>
            <p v-else>No credential attached.</p>
          </li>
        </ul>
        <p v-if="!request.grants.length">No HTTP routes are authorized.</p>
        <p>Approval expires {{ formatTime(request.expiresAt) }}.</p>
        <details>
          <summary>Exact source, revision and arguments</summary>
          <p>Change: <code>{{ request.changeId }}</code></p>
          <p>Revision: <code>{{ request.revision }}</code></p>
          <p>Source hash: <code>{{ request.sourceHash }}</code></p>
          <template v-if="request.source">
            <p>Source file: <code>{{ request.source.path }}</code></p>
            <pre>{{ request.source.code }}</pre>
          </template>
          <p>Connection: <code>{{ request.address.botInstanceId }}</code></p>
          <pre>{{ JSON.stringify(request.arguments, null, 2) }}</pre>
        </details>
      </div>
      <p v-if="request.runId">Recorded run: <code>{{ request.runId }}</code></p>
      <p v-if="request.error" class="probe-error" role="alert"><template v-if="request.status === 'completed'">Completed with a warning: </template>{{ request.error }}</p>
      <p v-if="request.status === 'completed'">Completed means this controlled probe finished, not that real conversation behavior or business acceptance was evaluated.</p>
      <p v-if="request.status === 'running' || operation === 'running'" role="status">Running the approved test. This may take up to 30 seconds; do not approve again.</p>
      <div v-if="request.status === 'pending'" class="probe-actions">
        <button type="button" :disabled="busy || needsReload" @click="cancel">{{ operation === 'cancelling' ? 'Cancelling…' : 'Cancel test' }}</button>
        <button type="button" class="probe-confirm" :disabled="busy || needsReload" @click="approve">{{ operation === 'running' ? 'Testing…' : 'Approve one test' }}</button>
      </div>
    </template>
    <p v-if="notice" role="status">{{ notice }}</p>
    <p v-if="error" class="probe-error" role="alert">{{ error }}</p>
    <button v-if="error" type="button" :disabled="busy || loading" @click="reload">{{ loading ? 'Reloading…' : 'Reload test status' }}</button>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useAuthoringProbes } from '../authoring-probes.ts'

const props = defineProps<{
  apiBase: string; projectId: string; sessionId: string; active: boolean; canSubmit: boolean; stage?: string | null
}>()
const documentVisible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const active = computed(() => props.active && documentVisible.value)
const { requests, request, selectedId, error, notice, loading, operation, busy, enabled, needsReload, approve, cancel, reload } =
  useAuthoringProbes(() => ({ ...props, active: active.value }))
function formatTime(value: string) { return new Date(value).toLocaleString() }
function visibility() { documentVisible.value = document.visibilityState !== 'hidden' }
onMounted(() => document.addEventListener('visibilitychange', visibility))
onUnmounted(() => document.removeEventListener('visibilitychange', visibility))
</script>

<style scoped>
.probe-request { box-sizing: border-box; flex: 0 1 auto; min-height: 0; width: calc(100% - 40px); max-width: 860px; max-height: min(48dvh, 460px); overflow-y: auto; overscroll-behavior: contain; margin: 8px auto 0; padding: 14px; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
h3 { margin: 0 0 8px; font-size: 14px; font-weight: 600; }
p { margin: 8px 0; }
.probe-summary, .probe-picker { color: var(--c-text-secondary); }
.probe-picker { display: block; margin-bottom: 12px; }
select { display: block; box-sizing: border-box; width: 100%; min-height: 34px; margin-top: 4px; padding: 6px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg); color: var(--c-text); font: inherit; }
.probe-review { max-height: 22dvh; overflow-y: auto; overscroll-behavior: contain; }
.probe-grants { margin: 8px 0; padding-inline-start: 20px; }
details { padding-block: 5px; }
summary { cursor: pointer; }
pre { margin: 8px 0 0; padding: 8px; background: var(--c-bg-muted); white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12px; }
.probe-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
button { min-height: 34px; padding: 6px 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; font-size: 12px; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .5; cursor: not-allowed; }
.probe-confirm { margin-inline-start: auto; background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.probe-confirm:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
button:focus-visible, summary:focus-visible, select:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.probe-error { color: var(--c-error); }
@media (max-width: 600px) { .probe-request { width: calc(100% - 24px); padding: 12px; } }
</style>
