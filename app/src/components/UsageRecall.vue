<template>
  <UsageBreakdown :title="t('Skill & Memory reads')" :category="t(group === 'project' ? 'Project' : 'Entry')"
    :count-label="t('Reads')" :rows="rows" :scope="`${kind}:${group}:${props.projects.map(p => p.id).join(',')}`" allow-column :allow-ring="false">
    <template #controls>
      <UiSelect v-model="kind" :aria-label="t('Recall type')">
        <option value="skills">{{ t('Skill') }}</option><option value="memory">{{ t('Memory') }}</option>
      </UiSelect>
      <UiSelect v-model="group" :aria-label="t('Group by')">
        <option value="entry">{{ t('Entry') }}</option><option value="project">{{ t('Project') }}</option>
      </UiSelect>
    </template>
    <template #coverage>
      <p>{{ t('Cumulative recorded reads, up to 100 entries per project. Legacy Skill counts have no dates. The selected usage period does not apply.') }}</p>
    </template>
  </UsageBreakdown>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
import UsageBreakdown from './UsageBreakdown.vue'
import UiSelect from './UiSelect.vue'
const props = defineProps<{ projects: { id: string; name: string; usage?: ProjectUsage | null }[] }>()
const kind = ref<'skills' | 'memory'>('skills')
const group = ref<'entry' | 'project'>('entry')
const rows = computed(() => {
  const entries = new Map<string, { id: string; name: string; calls: number }>()
  for (const project of props.projects) {
    const recall = project.usage?.recall
    if (!recall) continue
    for (const row of recall[kind.value]) {
      const source = 'source' in row ? row.source : null
      const id = group.value === 'project' ? project.id : JSON.stringify([row.entry, source])
      const name = group.value === 'project' ? project.name || t('Selected project')
        : source ? `${row.entry} · ${t(source === 'active' ? 'Active Wiki read' : 'Automatic log brief')}` : row.entry
      const current = entries.get(id) ?? { id, name, calls: 0 }
      current.calls += row.reads
      entries.set(id, current)
    }
  }
  return [...entries.values()]
})
</script>
