<template>
  <section class="session-profile" :aria-label="t('Conversation statistics')">
    <header><div><h2>{{ t('Conversation statistics') }}</h2><p>{{ t('Logical conversation across all physical segments. Own and including children are alternative scopes, not additive.') }}</p></div><button class="btn btn-sm" type="button" :disabled="loading || !active" @click="refresh">{{ t(loading ? 'Loading…' : error ? 'Retry' : profile ? 'Refresh' : 'Load statistics') }}</button></header>
    <p v-if="error" class="profile-error" role="alert">{{ error }}</p>
    <p v-if="!profile && !loading">{{ t('Load on demand. No background polling or model calls.') }}</p>
    <template v-if="profile">
      <p class="as-of" :title="profile.asOf">{{ t('As of {date}', { date: date(profile.asOf) }) }}</p>
      <section v-for="window in windows" :key="window.key">
        <h3>{{ t(window.label) }}</h3>
        <div class="scopes">
          <article v-for="scope in scopes" :key="scope.key">
            <h4>{{ t(scope.label) }}</h4>
            <ProfileMetrics :usage="profile[window.key][scope.key]" />
            <p>{{ t('Total tokens') }}: {{ token(profile[window.key][scope.key].totalTokens) }} · {{ t('Tracked sessions') }}: {{ profile[window.key][scope.key].trackedSessions }}</p>
          </article>
        </div>
      </section>
      <p>{{ t('Unknown is not zero. Known tokens are subtotals when usage is incomplete.') }}</p>
      <details><summary>{{ t('Measurement scope and limitations') }}</summary><ul><li v-for="item in profile.limitations" :key="item">{{ item }}</li></ul></details>
    </template>
  </section>
</template>
<script setup lang="ts">
import { onUnmounted, ref, watch } from 'vue'
import { apiUrl } from '../api-url.ts'
import { t, formatDateTime } from '../i18n.ts'
import ProfileMetrics from './ProfileMetrics.vue'
import type { SessionProfile } from '../../../src/sessions/profile-contract.ts'
const props = defineProps<{ apiBase: string; sessionId: string; active: boolean }>()
const profile = ref<SessionProfile | null>(null)
const loading = ref(false), error = ref('')
const windows = [{ key: 'rolling24h', label: 'Rolling 24h' }, { key: 'total', label: 'Conversation total' }] as const
const scopes = [{ key: 'own', label: 'Own conversation' }, { key: 'inclusive', label: 'Including children' }] as const
const token = (value: number | null) => value === null ? t('Unknown') : value.toLocaleString()
const date = (value: string) => formatDateTime(new Date(value), { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' })
let controller: AbortController | undefined
async function refresh() {
  controller?.abort()
  if (!props.active || !props.sessionId) return
  const current = controller = new AbortController()
  loading.value = true; error.value = ''
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/sessions/${encodeURIComponent(props.sessionId)}/profile`), { signal: current.signal })
    if (!response.ok) {
      if (controller === current && !current.signal.aborted) error.value = t(response.status === 401 || response.status === 403 ? 'Statistics access denied. Check your connection and permissions, then retry.' : response.status === 404 ? 'Statistics endpoint unavailable. Check that the backend supports profiling, then retry.' : 'Statistics unavailable (HTTP {status}). Retry.', { status: response.status })
      return
    }
    const body = await response.json()
    if (!body?.rolling24h?.own || !body?.total?.inclusive) throw new Error('Invalid profile')
    if (controller === current && !current.signal.aborted) profile.value = body
  } catch { if (!current.signal.aborted && controller === current) error.value = t('Statistics could not be loaded. Check your connection, then retry.') }
  finally { if (controller === current) loading.value = false }
}
watch(() => [props.apiBase, props.sessionId], () => { controller?.abort(); controller = undefined; profile.value = null; loading.value = false; error.value = '' })
watch(() => props.active, active => { if (!active) { controller?.abort(); controller = undefined; loading.value = false } })
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.session-profile { padding: 16px; font-size: 12px; min-width: 0; overflow-wrap: anywhere; }
header { display: flex; gap: 12px; justify-content: space-between; align-items: start; } header > div { min-width: 0; } header button { flex: 0 0 auto; }
h2 { font-size: 15px; font-weight: 600; margin: 0; } h3 { font-size: 13px; font-weight: 500; margin: 16px 0 8px; } h4 { font-size: 13px; font-weight: 500; margin: 0 0 8px; }
p { color: var(--c-text-secondary); line-height: 1.5; } .profile-error { color: var(--c-error); }
.scopes { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr)); gap: 12px; }
article { min-width: 0; border: 1px solid var(--c-border-soft); border-radius: var(--radius-surface); background: var(--c-bg-soft); padding: 12px; }
summary { cursor: pointer; min-height: 32px; align-content: center; color: var(--c-text-secondary); } summary:focus-visible { outline: 2px solid var(--c-blue); }
@media (max-width: 700px), (pointer: coarse) { header { flex-wrap: wrap; } summary { min-height: 44px; } }
</style>
