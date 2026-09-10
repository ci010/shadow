<template>
  <ul class="project-session-list">
    <li
      v-for="session in visibleSessions(sessions, collapsed)"
      :key="session.sessionId"
      class="project-session-row"
      :class="{ active: activeSessionId === session.sessionId }"
      :style="{ paddingLeft: `${Math.min(session.depth, 6) * 12 + 8}px` }"
    >
      <button
        v-if="parents.has(session.sessionId)"
        class="lineage-toggle"
        :aria-label="`${collapsed.has(session.sessionId) ? 'Expand' : 'Collapse'} conversations under ${session.label}`"
        :aria-expanded="!collapsed.has(session.sessionId)"
        @click="$emit('toggle', session.sessionId)"
      >{{ collapsed.has(session.sessionId) ? '›' : '⌄' }}</button>
      <span v-else class="lineage-spacer" aria-hidden="true">{{ session.depth ? '└' : '' }}</span>
      <button
        class="session-select"
        :aria-label="`${session.label}${session.isDirectChat ? '' : ' (read-only)'}`"
        :aria-current="activeSessionId === session.sessionId ? 'page' : undefined"
        :title="[session.label, session.sessionId, session.description, session.parentSessionId ? `Parent: ${session.parentSessionId}` : ''].filter(Boolean).join('\n')"
        @click="$emit('select', session.sessionId)"
      >
        <span class="session-label">{{ session.label }}</span>
        <span v-if="session.description" class="session-description">{{ session.description }}</span>
      </button>
      <span v-if="stages[session.sessionId] && stages[session.sessionId] !== 'inactive'" class="session-state" :title="stages[session.sessionId]">{{ stages[session.sessionId] }}</span>
      <span v-else-if="session.isCurrent" class="session-state">live</span>
      <button class="session-delete" :aria-label="`Delete conversation ${session.label}`" title="Delete conversation" @click="$emit('delete', session.sessionId)">×</button>
    </li>
  </ul>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { visibleSessions, type SidebarSession } from '../projects-sidebar.ts'
const props = defineProps<{
  sessions: SidebarSession[]
  activeSessionId: string
  collapsed: ReadonlySet<string>
  stages: Record<string, string>
}>()
defineEmits<{ select: [id: string]; delete: [id: string]; toggle: [id: string] }>()
const parents = computed(() => new Set(props.sessions.map(session => session.parentSessionId)))
</script>

<style scoped>
.project-session-list { list-style: none; padding: 0; margin: 3px 0 8px; }
.project-session-row { display: flex; align-items: center; gap: 3px; min-height: 36px; min-width: 0; padding-right: 4px; border-radius: 5px; }
.project-session-row:hover { background: var(--c-bg-muted); }
.project-session-row.active { background: var(--c-selection-bg); }
.session-select { display: flex; flex: 1; flex-direction: column; justify-content: center; min-width: 0; min-height: 36px; padding: 5px 1px; text-align: left; border: 0; color: var(--c-text-secondary); background: transparent; }
.active .session-select { color: var(--c-text); font-weight: 500; }
.session-label, .session-description { display: block; width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.session-label { font-size: 13px; }
.session-description { margin-top: 2px; font-size: 11px; color: var(--c-text-secondary); font-weight: 400; }
.lineage-toggle, .lineage-spacer { display: grid; place-items: center; flex: 0 0 18px; width: 18px; height: 28px; color: var(--c-text-secondary); font-size: 15px; }
.lineage-toggle, .session-delete { border: 0; border-radius: 3px; background: transparent; }
.session-delete { flex: 0 0 24px; width: 24px; height: 28px; font-size: 18px; color: var(--c-text-secondary); opacity: 0; }
.project-session-row:hover .session-delete, .project-session-row:focus-within .session-delete { opacity: 1; }
.session-delete:hover { background: var(--c-error-bg); color: var(--c-error); }
.lineage-toggle:hover { background: var(--c-bg-soft); color: var(--c-text); }
.session-state { flex-shrink: 0; color: var(--c-text-secondary); font-size: 10px; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
@media (hover: none), (max-width: 700px) { .session-delete { opacity: 1; } }
</style>
