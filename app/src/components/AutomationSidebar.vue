<template>
  <section v-if="jobs.length || initialLoading || error" class="automations-sidebar" :aria-label="t('Automations')" :aria-busy="loading">
    <h3 v-if="!rail">{{ t('Automations') }}</h3>
    <div v-if="error" class="automations-error" role="alert">
      <p v-if="!rail">{{ error }}</p>
      <button type="button" class="text-action" :aria-label="t('Retry automations')" @click="refresh">{{ t('Retry') }}</button>
    </div>
    <p v-if="initialLoading && !error && !rail" class="automations-note" role="status">{{ t('Loading automations…') }}</p>
    <HoverInfo v-for="job in jobs" :key="job.id" :text="t('{name} · Fresh context per run', { name: job.name })"><template #default="{ triggerProps }">
      <button type="button" class="automation-entry" v-bind="triggerProps" :class="{ selected: selectedId === job.id, 'is-rail': rail }"
        :aria-label="t('Open automation {name}', { name: job.name })" :aria-current="selectedId === job.id ? 'page' : undefined"
        :data-automation-id="job.id" @click="$emit('select', job.id)">
        <span class="i-lucide-repeat-2 automation-icon" aria-hidden="true" />
        <span v-if="!rail" class="automation-name">{{ job.name }}</span>
        <SessionActivity v-if="working(job.id)" :stage="working(job.id)" compact :icon-only="rail" :title="undefined" />
        <span v-else-if="!job.enabled && !rail" class="automation-history">{{ t('Inactive') }}</span>
      </button>
    </template></HoverInfo>
  </section>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed } from 'vue'
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
const { jobs, error, loading, loaded, refresh } = useAutomationCatalog(() => props.apiBase, () => props.active)
const initialLoading = computed(() => loading.value && !loaded.value)
function working(id: string) {
  return prominentWorkingStage(props.groups.find(group => group.id === id)?.sessions.map(session => props.stages[session.sessionId]) ?? [])
}
</script>

<style scoped>
.automations-sidebar { margin-top: var(--sidebar-section-gap); min-width: 0; }
.automations-sidebar:first-child { margin-top: 0; }
h3 { margin: 0 0 var(--sidebar-heading-gap); padding-inline: calc(var(--sidebar-row-inset) + var(--sidebar-disclosure) + var(--sidebar-heading-gap)) var(--sidebar-row-inset); color: var(--c-text-secondary); font-size: 12px; line-height: 20px; font-weight: 500; }
.automation-entry { display: flex; align-items: center; gap: var(--sidebar-icon-gap); width: 100%; min-width: 0; min-height: var(--sidebar-row-height); border: 0; border-radius: var(--radius-control); padding: 2px var(--sidebar-row-inset) 2px calc(var(--sidebar-row-inset) + var(--sidebar-disclosure) + var(--sidebar-heading-gap)); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; line-height: 20px; text-align: left; cursor: pointer; }
.automation-entry:hover { background: var(--c-bg-muted); }
.automation-entry.selected { background: var(--c-selection-bg); color: var(--c-primary); }
.automation-entry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.automation-icon { width: 16px; height: 16px; flex-shrink: 0; }
.automation-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.automation-history { color: var(--c-text-secondary); font-size: 12px; }
.automations-error, .automations-note { margin: 6px 8px; color: var(--c-text-secondary); font-size: 13px; }
.automations-error p { margin: 0 0 6px; overflow-wrap: anywhere; }
.automations-error button { min-height: 32px; padding: 4px 8px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); cursor: pointer; }
.automation-entry.is-rail { width: 44px; min-height: 44px; margin-inline: auto; padding: 8px; justify-content: center; }
</style>
