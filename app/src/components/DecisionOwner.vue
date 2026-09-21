<template>
  <details class="decision-owner" @toggle="toggle">
    <summary>Decision reporting responsibility</summary>
    <p>Choose who checks premises and explains this session's decisions to you. This does not change answer authority, parenthood or Initiative assignments.</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <template v-if="candidates.length">
      <label>Reporting session <select v-model="selected" :disabled="busy">
        <option v-for="item in candidates" :key="item.sessionId" :value="item.sessionId">{{ item.label }}</option>
      </select></label>
      <button type="button" :disabled="busy || selected === saved" @click="save">Save responsibility</button>
      <p v-if="saved">Assigned to: {{ saved }}</p>
    </template>
    <button v-else type="button" :disabled="busy" @click="load">{{ busy ? 'Loading...' : 'Load reporting sessions' }}</button>
  </details>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { apiUrl } from '../api-url.ts'
const props = defineProps<{ sessionId: string; apiBase: string }>()
const candidates = ref<{ sessionId: string; label: string }[]>([])
const selected = ref('')
const saved = ref('')
const error = ref('')
const busy = ref(false)
let opened = false
let controller: AbortController | undefined
async function request(method: 'GET' | 'POST') {
  controller?.abort()
  const current = new AbortController()
  controller = current
  busy.value = true; error.value = ''
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.sessionId)}/decisions/owner`), {
      method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reportingSessionId: selected.value }) } : {}),
      signal: AbortSignal.any([current.signal, AbortSignal.timeout(10000)]),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(data.message || 'Could not load or save decision responsibility.')
    if (typeof data.reportingSessionId !== 'string' || !Array.isArray(data.candidates)
      || data.candidates.some((item: unknown) => !item || typeof item !== 'object' || !('sessionId' in item) || typeof item.sessionId !== 'string'
        || !('label' in item) || typeof item.label !== 'string')) throw new Error('Invalid reporting responsibility response.')
    if (current.signal.aborted) return
    candidates.value = data.candidates; saved.value = selected.value = data.reportingSessionId
  } catch (cause) { if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Decision responsibility request failed.' }
  finally { if (controller === current) busy.value = false }
}
const load = () => request('GET')
const save = () => request('POST')
function toggle(event: Event) { opened = (event.currentTarget as HTMLDetailsElement).open; if (opened) void load(); else controller?.abort() }
watch(() => [props.apiBase, props.sessionId], () => { controller?.abort(); candidates.value = []; saved.value = selected.value = error.value = ''; if (opened) void load() })
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.decision-owner { margin: 4px 16px; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
summary { cursor: pointer; color: var(--c-text-secondary); }
p { margin: 6px 0; }
select { max-width: 100%; color: var(--c-text); background: var(--c-bg-input); }
button, select { min-height: 36px; border: 1px solid var(--c-border); padding: 4px 8px; }
button { background: var(--c-bg-card); cursor: pointer; }
[role=alert] { color: var(--c-error); }
</style>
