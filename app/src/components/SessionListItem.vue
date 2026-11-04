<script setup lang="ts">
import { t } from '../i18n.ts'
import { sidebarSessionIconStage, type SidebarSession } from '../folders-sidebar.ts'
import type { SubagentActivity } from '../subagent-executions.ts'
import SessionActivity from './SessionActivity.vue'
withDefaults(defineProps<{
  session: SidebarSession
  // Parts fit TreeRow's existing slots without moving lineage/actions into presentation.
  part: 'icon' | 'title' | 'metadata'
  stage?: string
  hasBackgroundTasks?: boolean
  subagents?: SubagentActivity
  metadata?: { folder: string; folderTitle?: string; folderTone?: number; time: string; absoluteTime: string }
  projectLabel?: string
}>(), { hasBackgroundTasks: undefined })
</script>
<template>
  <template v-if="part === 'icon'">
    <span v-if="session.groupObservation?.pending" class="i-lucide-message-circle-question w-4 h-4" :title="t('Pending setup approval')" />
    <span v-else-if="session.groupObservation && !session.groupObservation.enabled" class="i-lucide-circle-dashed w-4 h-4" :title="t('Not enabled')" />
    <SessionActivity v-else :stage="sidebarSessionIconStage(stage, session.completed)" :has-cron="session.hasCron" :has-background-tasks="hasBackgroundTasks ?? session.hasBackgroundTasks" :subagents="subagents" compact icon-only status-icons />
  </template>
  <span v-else-if="part === 'title'" class="session-item-title">{{ session.title || session.label }}</span>
  <span v-else-if="metadata" class="session-metadata">
    <span v-if="projectLabel" class="session-project-label">{{ projectLabel }}</span>
    <span class="session-folder-chip" :class="{ 'is-scratch': !session.folderId }" :data-folder-tone="metadata.folderTone" :title="metadata.folderTitle ?? metadata.folder">{{ metadata.folder }}</span>
    <time v-if="metadata.time" :datetime="session.lastActivityAt" :title="metadata.absoluteTime">{{ metadata.time }}</time>
  </span>
</template>
<style scoped>
.session-item-title { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-project-label { min-width: 0; max-width: 35%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-metadata { display: flex; align-items: center; gap: 6px; height: 16px; min-width: 0; }
.session-folder-chip { display: block; min-width: 0; max-width: 55%; overflow: hidden; text-overflow: ellipsis; padding-inline: 6px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--c-bg-muted) 88%, var(--c-text-secondary) 12%); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-border) 80%, var(--c-text-secondary) 20%); color: var(--c-text-secondary); font-weight: 500; line-height: 16px; }
.session-folder-chip[data-folder-tone] { background: color-mix(in srgb, var(--folder-chip-color) 18%, var(--c-bg-card)); color: color-mix(in srgb, var(--folder-chip-color) 65%, var(--c-text)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--folder-chip-color) 50%, var(--c-border)); }
.session-folder-chip[data-folder-tone="0"] { --folder-chip-color: #579dff; }
.session-folder-chip[data-folder-tone="1"] { --folder-chip-color: #df8cde; }
.session-folder-chip[data-folder-tone="2"] { --folder-chip-color: #45c5ac; }
.session-folder-chip[data-folder-tone="3"] { --folder-chip-color: #edb455; }
.session-folder-chip[data-folder-tone="4"] { --folder-chip-color: #b196ff; }
.session-folder-chip[data-folder-tone="5"] { --folder-chip-color: #f08e76; }
.session-folder-chip[data-folder-tone="6"] { --folder-chip-color: #64c5e4; }
.session-folder-chip[data-folder-tone="7"] { --folder-chip-color: #c3c65b; }
.session-folder-chip.is-scratch { background: transparent; box-shadow: none; padding-inline: 0; color: var(--c-text-secondary); font-weight: 400; }
.session-metadata time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
</style>
<style>
.session-list-row:hover { background: var(--c-bg-muted); }
.session-list-row.selected .session-icon { color: var(--c-primary); }
.session-list-row.selected { background: var(--c-selection-bg); color: var(--c-primary); }
</style>
