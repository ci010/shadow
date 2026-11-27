<template>
  <UsageBreakdown :title="t(kind === 'skills' ? 'Skill body reads' : 'Memory recall')" :category="t('Entry')"
    :count-label="t('Reads')" :rows="rows" :scope="`${kind}:${props.projects.map(p => p.id).join(',')}`" allow-column :allow-ring="false">
    <template #coverage>
      <p>{{ t('Regular-conversation active reads only; learning and automation are excluded. Automatic log injection is listed separately. Legacy/unknown-origin counts are retained but excluded. Up to 100 entries per project; the selected usage period does not apply.') }}</p>
    </template>
  </UsageBreakdown>
  <UsageBreakdown v-if="kind === 'memory'" :title="t('Automatic log brief')" :category="t('Entry')"
    :count-label="t('Reads')" :rows="automaticRows" :scope="`automatic:${props.projects.map(p => p.id).join(',')}`" allow-column :allow-ring="false" />
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
import UsageBreakdown from './UsageBreakdown.vue'
const props = defineProps<{ kind: 'skills' | 'memory'; projects: { id: string; name: string; usage?: ProjectUsage | null }[] }>()
function collect(automatic: boolean) {
  const entries = new Map<string, { id: string; name: string; calls: number }>()
  for (const project of props.projects) {
    const recall = project.usage?.recall
    if (!recall) continue
    for (const row of recall[props.kind]) {
      const source = 'source' in row ? row.source : null
      if ((source === 'automatic') !== automatic) continue
      const id = JSON.stringify([row.entry, source])
      const name = source ? `${row.entry} · ${t(source === 'active' ? 'Active Wiki read' : 'Automatic log brief')}` : row.entry
      const current = entries.get(id) ?? { id, name, calls: 0 }
      current.calls += row.reads
      entries.set(id, current)
    }
  }
  return [...entries.values()]
}
const rows = computed(() => collect(false))
const automaticRows = computed(() => collect(true))
</script>
