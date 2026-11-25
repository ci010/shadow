<template>
  <UsageBreakdown :title="t(kind === 'skills' ? 'Skill body reads' : 'Memory recall')" :category="t('Entry')"
    :count-label="t('Reads')" :rows="rows" :scope="`${kind}:${props.projects.map(p => p.id).join(',')}`" allow-column :allow-ring="false">
    <template #coverage>
      <p>{{ t('Cumulative recorded reads, up to 100 entries per project. Legacy Skill counts have no dates. The selected usage period does not apply.') }}</p>
    </template>
  </UsageBreakdown>
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
import UsageBreakdown from './UsageBreakdown.vue'
const props = defineProps<{ kind: 'skills' | 'memory'; projects: { id: string; name: string; usage?: ProjectUsage | null }[] }>()
const rows = computed(() => {
  const entries = new Map<string, { id: string; name: string; calls: number }>()
  for (const project of props.projects) {
    const recall = project.usage?.recall
    if (!recall) continue
    for (const row of recall[props.kind]) {
      const source = 'source' in row ? row.source : null
      const id = JSON.stringify([row.entry, source])
      const name = source ? `${row.entry} · ${t(source === 'active' ? 'Active Wiki read' : 'Automatic log brief')}` : row.entry
      const current = entries.get(id) ?? { id, name, calls: 0 }
      current.calls += row.reads
      entries.set(id, current)
    }
  }
  return [...entries.values()]
})
</script>
