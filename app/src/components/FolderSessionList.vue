<template>
  <ul class="folder-session-list">
    <TreeRow
      v-for="session in displayedSessions"
      :key="session.sessionId"
      as="li"
      class="folder-session-row"
      :class="{ active: isSelected(session), working: isWorking(session), 'needs-reply': activityStage(session) === 'waiting' }"
      :depth="Math.min(session.depth, 6) + depth"
      :selected="isSelected(session)"
      :icon-only="rail"
      :info-disabled="!showInfo"
      :label="session.label"
      :subtitle="sessionSubtitle?.(session)"
      :ariaLabel="`${session.label}${session.completed ? ` (${t('Completed')})` : ''}${activityStage(session) === 'waiting' ? ' (needs reply)' : ''}${delegatedLabel(session) ? ` (${delegatedLabel(session)})` : ''}${session.isDirectChat ? '' : ' (read-only)'}`"
      :current="activeSessionId === session.sessionId ? 'page' : undefined"
      :title="[session.label, session.sessionId, session.description, session.completed ? t('Completed') : '', session.parentSessionId ? t('Parent: {parentSessionId}', { parentSessionId: session.parentSessionId }) : session.contextParentSessionId ? t('Forked from: {contextParentSessionId}', { contextParentSessionId: session.contextParentSessionId }) : ''].filter(Boolean).join('\n')"
      separate-toggle
      button-class="session-select"
      toggle-class="lineage-toggle"
      :expanded="parents.has(session.sessionId) ? !collapsed.has(session.sessionId) : undefined"
      :toggle-label="`${collapsed.has(session.sessionId) ? 'Expand' : 'Collapse'} conversations under ${session.label}`"
      @toggle="$emit('toggle', session.sessionId)"
      @select="$emit('select', session.sessionId)"
    >
      <template v-if="sessionMetadata" #subtitle>
        <span class="session-metadata">
          <span class="session-folder-chip" :class="{ 'is-scratch': !session.folderId }" :title="sessionMetadata(session).folder">{{ sessionMetadata(session).folder }}</span>
          <time v-if="sessionMetadata(session).time" :datetime="session.lastActivityAt" :title="sessionMetadata(session).absoluteTime">{{ sessionMetadata(session).time }}</time>
        </span>
      </template>
      <template #icon>
        <span v-if="session.groupObservation?.pending" class="i-lucide-message-circle-question w-4 h-4" :title="t('Pending setup approval')" />
        <span v-else-if="session.groupObservation && !session.groupObservation.enabled" class="i-lucide-circle-dashed w-4 h-4" :title="t('Not enabled')" />
        <SessionActivity v-else :stage="sidebarSessionIconStage(activityStage(session), session.completed)" :has-cron="session.hasCron" :subagents="delegatedActivity(session)" compact icon-only status-icons />
      </template>
      <template #meta><WorkingWave v-if="isAnimating(session)" class="session-working-wave" /></template>
      <template v-if="!session.sessionId.startsWith('observed-group:')" #actions><HoverInfo text="Delete conversation" :disabled="!showInfo"><template #default="{ triggerProps }"><button class="session-delete" v-bind="triggerProps" :aria-label="t('Delete conversation {label}', { label: session.label })" @click="$emit('delete', session.sessionId)"><span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" /></button></template></HoverInfo></template>
      <template v-if="showInfo" #info="{ close }">
        <div class="session-info">
          <strong class="session-info-title">{{ session.label }}</strong>
          <p v-if="session.description" class="session-info-description">{{ session.description }}</p>
          <div class="session-info-status">
            <span v-if="session.completed">{{ t('Completed') }}</span>
            <SessionActivity :stage="stages[session.sessionId]" status-icons />
            <span v-if="!session.isDirectChat" class="session-info-readonly"><span class="i-lucide-lock-keyhole" aria-hidden="true" />{{ t('Read-only') }}</span>
          </div>
          <div class="session-info-identity">
            <span class="session-info-key">{{ t('Session ID') }}</span>
            <CopyableId class="session-info-id" :value="session.sessionId" :label="t('Session ID')" />
          </div>
          <p v-if="delegatedLabel(session)">{{ delegatedLabel(session) }}</p>
          <div class="session-info-actions">
            <button type="button" class="session-info-open" @click="$emit('select', session.sessionId); close()">{{ t('Open conversation') }}</button>
            <button v-if="!session.sessionId.startsWith('observed-group:')" type="button" class="session-info-delete" :aria-label="t('Delete conversation {label}', { label: session.label })" @click="close(); $emit('delete', session.sessionId)">{{ t('Delete conversation') }}</button>
          </div>
          <template v-if="descendants(session).length">
            <h4>{{ t('Related conversations') }}</h4>
            <FolderSessionList class="session-info-related" :sessions="descendants(session)" :active-session-id="activeSessionId" :collapsed="collapsed"
              :stages="stages" :executions-by-owner="executionsByOwner" :show-info="false" @select="$emit('select', $event); close()" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
          </template>
        </div>
      </template>
    </TreeRow>
  </ul>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed } from 'vue'
import { sidebarSessionIconStage, sessionNavigationParent, visibleSessions, type SidebarSession } from '../folders-sidebar.ts'
import SessionActivity from './SessionActivity.vue'
import WorkingWave from './WorkingWave.vue'
import TreeRow from './TreeRow.vue'
import HoverInfo from './HoverInfo.vue'
import CopyableId from './CopyableId.vue'
import { rootSessionFamilies } from '../folder-rail.ts'
import { isAnimatingStage, isWorkingStage, prominentWorkingStage } from '../session-activity.ts'
import { subagentActivityLabel, summarizeSubagents } from '../subagent-executions.ts'
const props = withDefaults(defineProps<{
  sessionMetadata?: (session: SidebarSession) => { folder: string; time: string; absoluteTime: string }
  sessionSubtitle?: (session: SidebarSession) => string
  sessions: SidebarSession[]
  activeSessionId: string
  collapsed: ReadonlySet<string>
  stages: Record<string, string>
  executionsByOwner?: ReadonlyMap<string, readonly SidebarSession[]>
  depth?: number
  rail?: boolean
  showInfo?: boolean
}>(), { depth: 0, rail: false, showInfo: true })
defineEmits<{ select: [id: string]; delete: [id: string]; toggle: [id: string] }>()
const parents = computed(() => new Set(props.sessions.map(sessionNavigationParent)))
const families = computed(() => rootSessionFamilies(props.sessions))
const displayedSessions = computed(() => props.rail ? families.value.map(family => family[0]) : visibleSessions(props.sessions, props.collapsed))
function family(session: SidebarSession) { return families.value.find(items => items[0].sessionId === session.sessionId) ?? [session] }
function descendants(session: SidebarSession) {
  return family(session).slice(1).map(item => ({ ...item, depth: Math.max(0, item.depth - session.depth - 1) }))
}
function isSelected(session: SidebarSession) {
  return props.rail ? family(session).some(item => item.sessionId === props.activeSessionId) : session.sessionId === props.activeSessionId
}
function activityStage(session: SidebarSession) {
  return props.rail ? prominentWorkingStage(family(session).map(item => props.stages[item.sessionId])) ?? props.stages[session.sessionId] : props.stages[session.sessionId]
}
function delegatedActivity(session: SidebarSession) {
  const members = props.rail ? family(session) : [session]
  return summarizeSubagents(members.flatMap(item => props.executionsByOwner?.get(item.sessionId) ?? []), props.stages)
}
function delegatedLabel(session: SidebarSession) { return subagentActivityLabel(delegatedActivity(session)) }
function isAnimating(session: SidebarSession) {
  const members = props.rail ? family(session) : [session]
  return members.some(item => isAnimatingStage(props.stages[item.sessionId])) || delegatedActivity(session).running > 0
}
function isWorking(session: SidebarSession) { return isWorkingStage(activityStage(session)) || delegatedActivity(session).running > 0 }
</script>

<style scoped>
.session-metadata { display: flex; align-items: center; gap: 6px; height: 16px; min-width: 0; }
.session-folder-chip { display: block; min-width: 0; max-width: 55%; overflow: hidden; text-overflow: ellipsis; padding-inline: 6px; border-radius: var(--radius-sm); background: color-mix(in srgb, var(--c-bg-muted) 88%, var(--c-text-secondary) 12%); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--c-border) 80%, var(--c-text-secondary) 20%); color: var(--c-text-secondary); font-weight: 500; line-height: 16px; }
.session-folder-chip.is-scratch { background: transparent; box-shadow: none; padding-inline: 0; color: var(--c-text-secondary); font-weight: 400; }
.session-metadata time { flex-shrink: 0; font-variant-numeric: tabular-nums; }
.session-working-wave { color: var(--c-text-secondary); }
.folder-session-list { list-style: none; padding: 0; margin: 0; }
.folder-session-row.needs-reply { box-shadow: inset 3px 0 var(--c-warn); background: var(--c-warn-bg); }
.folder-session-row.needs-reply.active { background: var(--c-selection-bg); }
.session-delete { border: 0; border-radius: var(--radius-sm); background: transparent; cursor: pointer; }
.session-delete { display: grid; place-items: center; flex: 0 0 24px; width: 24px; height: 28px; color: var(--c-text-secondary); opacity: 0; }
.folder-session-row:hover .session-delete, .folder-session-row:focus-within .session-delete { opacity: 1; }
.session-delete:hover { background: var(--c-error-bg); color: var(--c-error); }
.folder-session-row.icon-only + .folder-session-row.icon-only { margin-top: 8px; }
.session-info { min-width: 0; }
.session-info-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 3em; overflow: hidden; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; font-weight: 600; }
.session-info p { margin: 6px 0; color: var(--c-text-secondary); white-space: pre-line; overflow-wrap: anywhere; }
.session-info-description { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; max-height: 4.5em; overflow: hidden; line-height: 1.5; }
.session-info-status { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; margin-top: 8px; }
.session-info-readonly { display: inline-flex; align-items: center; gap: 6px; color: var(--c-text-secondary); }
.session-info-readonly > span { width: 14px; height: 14px; }
.session-info-identity { margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--c-border-soft); }
.session-info-key { font-size: 12px; color: var(--c-text-muted); }
.session-info-related { max-height: min(204px, 30dvh); overflow: auto; overscroll-behavior: contain; }
.session-info h4 { margin: 16px 0 6px; font-size: 12px; font-weight: 500; color: var(--c-text-secondary); }
.session-info-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 6px; }
.session-info-open, .session-info-delete { padding: 6px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.session-info-open:hover { background: var(--c-bg-muted); }
.session-info-delete { color: var(--c-error); }
.session-info-delete:hover { background: var(--c-error-bg); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
@media (hover: none), (max-width: 700px) { .session-delete { opacity: 1; } }
</style>
