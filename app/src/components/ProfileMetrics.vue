<template>
  <dl class="profile-metrics">
    <div><dt>{{ t('Input tokens') }}</dt><dd>{{ token(usage.inputTokens) }}</dd></div>
    <div><dt>{{ t('Output tokens') }}</dt><dd>{{ token(usage.outputTokens) }}</dd></div>
    <div><dt>{{ t('Recorded provider calls') }}</dt><dd>{{ formatNumber(usage.providerCalls) }}</dd></div>
    <div><dt>{{ t('Recorded tool results') }}</dt><dd>{{ formatNumber(usage.toolCalls) }}</dd></div>
  </dl>
  <p class="profile-coverage">{{ t('Usage known / unknown calls') }}: {{ usage.knownUsageCalls }} / {{ usage.unknownUsageCalls }} · {{ t('Untracked sessions') }}: {{ usage.untrackedSessions }}</p>
  <p v-if="usage.scanLimitReached" class="profile-coverage" role="status">{{ t('Scan limited — counts and known tokens are lower bounds.') }}</p>
</template>
<script setup lang="ts">
import { t, formatNumber } from '../i18n.ts'
import type { UsageMetrics } from '../../../src/sessions/profile-contract.ts'
defineProps<{ usage: UsageMetrics }>()
const token = (value: number | null) => value === null ? t('Unknown') : formatNumber(value)
</script>
<style scoped>
.profile-metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 8px 0; }
.profile-metrics div { min-width: 0; border-inline-start: 1px solid var(--c-border-soft); padding-inline-start: 10px; }
dt, .profile-coverage { color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
dd { margin: 2px 0 0; font-size: 15px; font-weight: 500; font-variant-numeric: tabular-nums; overflow-wrap: anywhere; }
.profile-coverage { margin: 4px 0; }
@media (max-width: 700px) { .profile-metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; } }
</style>
