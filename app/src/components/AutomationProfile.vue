<template>
  <section class="automation-profile" :aria-label="t('Automation statistics')" :aria-busy="loading">
    <header><strong>{{ t('Rolling 24h') }}</strong><button class="btn btn-sm" type="button" :disabled="loading || !active" @click="refresh">{{ t(error ? 'Retry' : 'Refresh') }}</button></header>
    <p v-if="error" class="profile-error" role="alert">{{ error }}</p>
    <p v-else-if="!profile" role="status">{{ t(loading ? 'Loading metrics…' : 'No metrics available.') }}</p>
    <template v-if="profile">
      <ProfileMetrics :usage="profile.usage" />
      <details class="measurement"><summary>{{ t('Measurement scope and limitations') }} · {{ profile.runs.total }} {{ t('Runs') }} · {{ t('Coverage') }}: {{ t(profile.coverage === 'complete' ? 'Complete' : profile.coverage === 'partial' ? 'Partial' : 'Unknown') }}</summary>
        <div class="measurement-body">
          <p>{{ profile.runs.completed }} {{ t('Completed') }} · {{ profile.runs.running }} {{ t('Running') }} · {{ profile.runs.failed }} {{ t('Failed') }} · {{ profile.runs.partial }} {{ t('Partial') }} · {{ profile.runs.cancelled }} {{ t('Cancelled') }} · {{ profile.runs.unknown }} {{ t('Unknown') }}</p>
          <p>{{ t('Window') }}: <time :datetime="profile.window.from" :title="profile.window.from">{{ date(profile.window.from) }}</time> — <time :datetime="profile.window.asOf" :title="profile.window.asOf">{{ date(profile.window.asOf) }}</time></p>
          <p>{{ t('Frequency') }}: {{ profile.frequency.description }} ({{ profile.frequency.scope }})</p>
          <p v-if="profile.organizationScopes"><span v-for="(metrics, mode) in profile.organizationScopes" :key="mode">{{ t(mode === 'full' ? 'Full' : 'Delta') }}: {{ profile.runs[mode] }} {{ t('Runs') }} / {{ metrics?.providerCalls }} {{ t('Recorded provider calls') }} / {{ token(metrics?.inputTokens ?? null) }} {{ t('Input tokens') }} / {{ token(metrics?.outputTokens ?? null) }} {{ t('Output tokens') }} · </span></p>
          <p>{{ t('Unknown is not zero. Known tokens are subtotals when usage is incomplete.') }}</p>
          <ul><li v-for="item in profile.limitations" :key="item">{{ item }}</li></ul>
        </div>
      </details>
    </template>
  </section>
</template>
<script setup lang="ts">
import { ref, watch, onUnmounted } from 'vue'
import { t, formatDateTime } from '../i18n.ts'
import { automationProfileUrl } from '../profile-api.ts'
import ProfileMetrics from './ProfileMetrics.vue'
import type { AutomationProfile } from '../../../src/cron/profile-contract.ts'
const props = defineProps<{ apiBase: string; featureId: string; active: boolean }>()
const profile = ref<AutomationProfile | null>(null), loading = ref(false), error = ref('')
let controller: AbortController | undefined
const token = (value: number | null) => value === null ? t('Unknown') : value.toLocaleString()
const date = (value: string) => formatDateTime(new Date(value), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
async function refresh() {
  controller?.abort()
  if (!props.active || !props.featureId) return
  const current = controller = new AbortController()
  loading.value = true; error.value = ''
  try {
    const response = await fetch(automationProfileUrl(props.apiBase, props.featureId), { signal: current.signal })
    if (!response.ok) {
      if (controller === current && !current.signal.aborted) error.value = t(response.status === 401 || response.status === 403 ? 'Statistics access denied. Check your connection and permissions, then retry.' : response.status === 404 ? 'Statistics endpoint unavailable. Check that the backend supports profiling, then retry.' : 'Statistics unavailable (HTTP {status}). Retry.', { status: response.status })
      return
    }
    const body = await response.json()
    if (!body?.profile?.usage || !body.profile.window) throw new Error('Invalid profile')
    if (controller === current && !current.signal.aborted) profile.value = body.profile
  } catch { if (!current.signal.aborted && controller === current) error.value = t('Statistics could not be loaded. Check your connection, then retry.') }
  finally { if (controller === current) loading.value = false }
}
watch(() => [props.apiBase, props.featureId, props.active], () => { controller?.abort(); profile.value = null; void refresh() }, { immediate: true })
onUnmounted(() => controller?.abort())
</script>
<style scoped>
.automation-profile { flex: 0 0 auto; padding: 8px 16px; font-size: 12px; border-top: 1px solid var(--c-border-soft); min-width: 0; max-height: 180px; overflow: auto; }
header { display: flex; gap: 12px; align-items: center; justify-content: space-between; min-width: 0; }
header strong { flex: 0 0 auto; font-weight: 500; white-space: nowrap; color: var(--c-text-secondary); }
header button { flex: 0 0 auto; white-space: nowrap; min-width: 48px; }
.automation-profile :deep(.profile-metrics) { margin: 12px 0 10px; gap: 16px; }
.automation-profile :deep(.profile-metrics > div) { border-inline-start: 0; padding-inline-start: 0; }
.automation-profile :deep(.profile-metrics dt) { font-size: 12px; line-height: 1.5; }
.automation-profile :deep(.profile-metrics dd) { margin-top: 4px; font-size: 18px; line-height: 1.3; font-weight: 600; }
.automation-profile :deep(.profile-coverage) { font-size: 11px; line-height: 1.6; }
p { margin: 4px 0; color: var(--c-text-secondary); } .profile-error { color: var(--c-error); overflow-wrap: anywhere; }
.measurement summary { cursor: pointer; color: var(--c-text-secondary); padding: 4px 0; } .measurement-body { overflow-wrap: anywhere; }
@media (max-width: 700px) { .automation-profile { padding-inline: 12px; max-height: 220px; } .automation-profile :deep(.profile-metrics) { gap: 12px 16px; } }
</style>
