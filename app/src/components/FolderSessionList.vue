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
      :ariaLabel="`${session.label}${activityStage(session) === 'waiting' ? ' (needs reply)' : ''}${session.isDirectChat ? '' : ' (read-only)'}`"
      :current="activeSessionId === session.sessionId ? 'page' : undefined"
      :title="[session.label, session.sessionId, session.description, session.parentSessionId ? `Parent: ${session.parentSessionId}` : session.contextParentSessionId ? `Forked from: ${session.contextParentSessionId}` : ''].filter(Boolean).join('\n')"
      separate-toggle
      button-class="session-select"
      toggle-class="lineage-toggle"
      :expanded="parents.has(session.sessionId) ? !collapsed.has(session.sessionId) : undefined"
      :toggle-label="`${collapsed.has(session.sessionId) ? 'Expand' : 'Collapse'} conversations under ${session.label}`"
      @toggle="$emit('toggle', session.sessionId)"
      @select="$emit('select', session.sessionId)"
    >
      <template #icon><span :class="session.isDirectChat ? 'i-lucide-message-square' : 'i-lucide-bot'" /></template>
      <template #meta><SessionActivity :stage="activityStage(session)" compact :icon-only="rail" :title="undefined" /></template>
      <template #actions><HoverInfo text="Delete conversation" :disabled="!showInfo"><template #default="{ triggerProps }"><button class="session-delete" v-bind="triggerProps" :aria-label="`Delete conversation ${session.label}`" @click="$emit('delete', session.sessionId)"><span class="i-lucide-x w-3.5 h-3.5" aria-hidden="true" /></button></template></HoverInfo></template>
      <template v-if="showInfo" #info="{ close }">
        <div class="session-info">
          <strong class="session-info-title">{{ session.label }}</strong>
          <p v-if="session.description" class="session-info-description">{{ session.description }}</p>
          <p v-if="session.topic?.goal" class="session-info-description"><strong>Goal:</strong> {{ session.topic.goal }}</p>
          <p v-if="session.topic?.scope" class="session-info-description"><strong>Scope:</strong> {{ session.topic.scope }}</p>
          <p class="session-info-id">{{ session.sessionId }}</p>
          <p>{{ sessionActivity(stages[session.sessionId]).label }}<span v-if="!session.isDirectChat"> · Read-only</span></p>
          <button class="session-info-open" @click="$emit('select', session.sessionId); close()">Open conversation</button>
          <template v-if="descendants(session).length">
            <h4>Related conversations</h4>
            <FolderSessionList class="session-info-related" :sessions="descendants(session)" :active-session-id="activeSessionId" :collapsed="collapsed"
              :stages="stages" :show-info="false" @select="$emit('select', $event); close()" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
          </template>
        </div>
      </template>
    </TreeRow>
  </ul>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { sessionNavigationParent, visibleSessions, type SidebarSession } from '../folders-sidebar.ts'
import SessionActivity from './SessionActivity.vue'
import TreeRow from './TreeRow.vue'
import HoverInfo from './HoverInfo.vue'
import { rootSessionFamilies } from '../folder-rail.ts'
import { isWorkingStage, prominentWorkingStage, sessionActivity } from '../session-activity.ts'
const props = withDefaults(defineProps<{
  sessions: SidebarSession[]
  activeSessionId: string
  collapsed: ReadonlySet<string>
  stages: Record<string, string>
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
function isWorking(session: SidebarSession) { return isWorkingStage(activityStage(session)) }
</script>

<style scoped>
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
.session-info .session-info-id { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--c-text-faint); }
.session-info-related { max-height: min(204px, 30dvh); overflow: auto; overscroll-behavior: contain; }
.session-info h4 { margin: 16px 0 6px; font-size: 12px; font-weight: 500; color: var(--c-text-secondary); }
.session-info-open { margin-top: 6px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.session-info-open:hover { background: var(--c-bg-muted); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
@media (hover: none), (max-width: 700px) { .session-delete { opacity: 1; } }
</style>
