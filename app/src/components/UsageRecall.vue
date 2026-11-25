<template>
  <section class="recall" :aria-label="t('Recall')">
    <div class="heading"><h3>{{ t('Skill & Memory reads') }}</h3><div v-if="hasRecall" role="group" :aria-label="t('Recall type')">
      <button v-for="item in recallTypes" :key="item.key" class="btn btn-sm" type="button" :aria-pressed="recallType === item.key" @click="recallType = item.key">{{ t(item.label) }}</button>
    </div></div>
    <p v-if="hasRecall">{{ t('Cumulative recorded reads, up to 100 entries per project. Legacy Skill counts have no dates. The selected usage period does not apply.') }}</p>
    <p v-if="!projects.length">{{ t('Unavailable') }}</p>
    <template v-for="project in projects" :key="project.id">
      <details v-if="project.usage?.recall" :open="projects.length === 1">
        <summary>{{ project.name || t('Selected project') }}</summary>
        <UsageBreakdown :title="t(recallType === 'skills' ? 'Skill body reads' : 'Memory recall')" :category="t('Entry')"
          :description="coverage(project.usage.recall.coverage)" :count-label="t('Reads')" :allow-ring="false" :scope="`${project.id}:${recallType}`"
          :rows="recallType === 'skills' ? project.usage.recall.skills.map(row => ({ id: row.entry, name: row.entry, calls: row.reads }))
            : project.usage.recall.memory.map(row => ({ id: `${row.source}:${row.entry}`, name: `${row.entry} · ${t(row.source === 'active' ? 'Active Wiki read' : 'Automatic log brief')}`, calls: row.reads }))" />
      </details>
      <p v-else class="recall-status">
        <template v-if="project.name">{{ project.name }} · </template>{{ t('Usage unavailable') }}
      </p>
    </template>
  </section>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n.ts'
import type { ProjectUsage } from '../../../src/projects/usage-contract.ts'
import UsageBreakdown from './UsageBreakdown.vue'
const props = defineProps<{ projects: { id: string; name: string; usage?: ProjectUsage | null }[] }>()
const hasRecall = computed(() => props.projects.some(project => project.usage?.recall))
const recallType = ref<'skills' | 'memory'>('skills')
const recallTypes = [{ key: 'skills', label: 'Skill' }, { key: 'memory', label: 'Memory' }] as const
function coverage(value: string) { return t(value === 'complete' ? 'Index backfill complete' : 'Index coverage partial') }
</script>
<style scoped>
.recall { min-width: 0; }
.heading { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
.heading button[aria-pressed=true] { background: var(--c-selection-bg); color: var(--c-primary); }
h3 { margin: 0; font-size: 13px; font-weight: 600; }
.recall-status { overflow-wrap: anywhere; }
p, details { font-size: 12px; color: var(--c-text-secondary); }
details { border-top: 1px solid var(--c-border); padding: 8px 0; }
summary { cursor: pointer; margin-bottom: 6px; overflow-wrap: anywhere; }
</style>
