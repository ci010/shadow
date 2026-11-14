<template>
  <nav v-if="projectId" class="automations-sidebar" :aria-label="t('Workflows')">
    <HoverInfo :text="t('Knowledge')"><template #default="{ triggerProps }">
      <button type="button" v-bind="triggerProps" class="automation-entry" :class="{ 'is-rail': rail }"
        :aria-label="t('Knowledge')" aria-keyshortcuts="Control+K Meta+K" @click="$emit('knowledge')">
        <span class="i-lucide-book-open automation-icon" aria-hidden="true" /><span v-if="!rail">{{ t('Knowledge') }}</span>
        <kbd v-if="!rail" class="navigation-shortcut">Ctrl+K</kbd>
      </button>
    </template></HoverInfo>
    <HoverInfo :text="t('Workflows')"><template #default="{ triggerProps }">
      <RouterLink v-bind="triggerProps" aria-keyshortcuts="Control+J Meta+J" class="automation-entry" active-class="selected" :class="{ 'is-rail': rail }"
        :to="{ name: 'project-workflows', params: { projectId }, query: route.name === 'project-workflows' && route.params.projectId === projectId ? route.query : {} }" :aria-label="t('Workflows')">
        <span class="i-lucide-workflow automation-icon" aria-hidden="true" /><span v-if="!rail">{{ t('Workflows') }}</span>
        <kbd v-if="!rail" class="navigation-shortcut">Ctrl+J</kbd>
      </RouterLink>
    </template></HoverInfo>
  </nav>
</template>

<script setup lang="ts">
import { RouterLink, useRoute } from 'vue-router'
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
import type { SidebarSession } from '../folders-sidebar.ts'

const route = useRoute()

// Keep the parent contract stable; individual runs now live behind the Workflow page.
defineProps<{
  projectId?: string; apiBase: string; active: boolean; rail?: boolean; selectedId?: string
  groups: Array<{ id: string; sessions: SidebarSession[] }>; stages: Record<string, string>
}>()
defineEmits<{ select: [id: string]; knowledge: [] }>()
</script>

<style scoped>
.automations-sidebar { min-width: 0; }
.navigation-shortcut { margin-inline-start: auto; flex-shrink: 0; padding: 1px 4px; border: 1px solid var(--c-border); border-radius: var(--radius-sm); background: var(--c-bg-soft); color: var(--c-text-secondary); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; font-weight: 400; line-height: 16px; white-space: nowrap; }
.automation-entry { box-sizing: border-box; display: flex; align-items: center; gap: var(--sidebar-icon-gap); width: 100%; min-width: 0; min-height: calc(var(--sidebar-row-height) + 8px); border: 0; background: transparent; text-align: left; cursor: pointer; border-radius: var(--radius-control); padding: 2px var(--sidebar-row-inset); padding-inline-start: calc(var(--sidebar-row-inset) + var(--sidebar-disclosure) + var(--sidebar-heading-gap)); color: var(--c-text); font: inherit; font-size: 13px; line-height: 20px; text-decoration: none; }
.automation-entry:hover { background: var(--c-bg-muted); }
.automation-entry.selected { background: var(--c-selection-bg); color: var(--c-primary); }
.automation-entry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.automation-icon { width: 16px; height: 16px; flex-shrink: 0; }
.automation-entry.is-rail { width: 44px; min-height: 44px; margin-inline: auto; padding: 8px; justify-content: center; }
</style>
