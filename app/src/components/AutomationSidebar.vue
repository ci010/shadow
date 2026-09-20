<template>
  <section v-if="jobs.length || loading || error" class="automations-sidebar" aria-label="Automations" :aria-busy="loading">
    <h3 v-if="!rail">Automations</h3>
    <div v-if="error" class="automations-error" role="alert">
      <p v-if="!rail">{{ error }}</p>
      <button type="button" class="text-action" aria-label="Retry automations" @click="refresh">Retry</button>
    </div>
    <p v-if="loading && !jobs.length && !error && !rail" class="automations-note" role="status">Loading automations…</p>
    <HoverInfo v-for="job in jobs" :key="job.id" :text="`${job.name} · Fresh context per run`"><template #default="{ triggerProps }">
      <button type="button" class="automation-entry" v-bind="triggerProps" :class="{ selected: selectedId === job.id, 'is-rail': rail }"
        :aria-label="`Open automation ${job.name}`" :aria-current="selectedId === job.id ? 'page' : undefined"
        :data-automation-id="job.id" @click="$emit('select', job.id)">
        <span class="i-lucide-repeat-2 automation-icon" aria-hidden="true" />
        <span v-if="!rail" class="automation-name">{{ job.name }}</span>
        <SessionActivity v-if="working(job.id)" :stage="working(job.id)" compact :icon-only="rail" :title="undefined" />
        <span v-else-if="!job.enabled && !rail" class="automation-history">Inactive</span>
      </button>
    </template></HoverInfo>
  </section>
</template>

<script setup lang="ts">
import HoverInfo from './HoverInfo.vue'
import SessionActivity from './SessionActivity.vue'
import { useAutomationCatalog } from '../composables/useAutomationCatalog.ts'
import { prominentWorkingStage } from '../session-activity.ts'
import type { SidebarSession } from '../folders-sidebar.ts'

const props = defineProps<{
  apiBase: string; active: boolean; rail?: boolean; selectedId?: string
  groups: Array<{ id: string; sessions: SidebarSession[] }>; stages: Record<string, string>
}>()
defineEmits<{ select: [id: string] }>()
const { jobs, error, loading, refresh } = useAutomationCatalog(() => props.apiBase, () => props.active)
function working(id: string) {
  return prominentWorkingStage(props.groups.find(group => group.id === id)?.sessions.map(session => props.stages[session.sessionId]) ?? [])
}
</script>

<style scoped>
.automations-sidebar { margin-top: 20px; min-width: 0; }
h3 { margin: 0 8px 6px; color: var(--c-text-secondary); font-size: 12px; font-weight: 500; }
.automation-entry { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; min-height: 36px; border: 0; padding: 6px 8px; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.automation-entry:hover { background: var(--c-bg-muted); }
.automation-entry.selected { background: var(--c-selection-bg); }
.automation-entry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.automation-icon { width: 16px; height: 16px; flex-shrink: 0; }
.automation-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.automation-history { color: var(--c-text-secondary); font-size: 12px; }
.automations-error, .automations-note { margin: 6px 8px; color: var(--c-text-secondary); font-size: 13px; }
.automations-error p { margin: 0 0 6px; overflow-wrap: anywhere; }
.automations-error button { min-height: 32px; padding: 4px 8px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
.automation-entry.is-rail { width: 44px; min-height: 44px; padding: 8px; justify-content: center; }
@media (max-width: 700px) { .automation-entry { min-height: 44px; } }
</style>
