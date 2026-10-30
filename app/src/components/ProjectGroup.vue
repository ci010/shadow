<template>
  <FoldersSidebar :api-base="scope" grouped :project-id="project.id" :project-name="project.name" :bots="displayBots"
    :selected-automation-id="selectedProjectId === project.id ? selectedAutomationId : undefined"
    :folder-revision="(folderRevision ?? 0) + liveFolderRevision"
    :sessions="displaySessions" :active-session-id="selectedProjectId === project.id ? selectedSessionId : ''"
    :draft-folder-id="selectedProjectId === project.id ? draftFolderId : undefined"
    :collapsed="collapsed" :stages="stages" :sessions-loading="loading" :sessions-error="error"
    :remote-folders="remoteFolders" @select="$emit('select', $event)" @delete="deleteSession"
    @toggle="toggle" @reload="refresh" @scratch="$emit('draft')" @remote="$emit('draft', undefined, true)" @draft="$emit('draft', $event)"
    @manage="(folder, action) => $emit('manage', folder, action)" @automation="$emit('automation', $event)">
    <template #project-name>
      <button type="button" class="project-entry" :class="{ selected: selectedProjectId === project.id && dashboardSelected }" :aria-current="selectedProjectId === project.id && dashboardSelected ? 'page' : undefined" :title="t('{name} dashboard', { name: project.name })" @click="$emit('dashboard')">{{ project.name }}</button>
    </template>
    <template #project-actions>
      <button class="project-settings" :aria-label="t('{name} knowledge', { name: project.name })" :title="t('{name} knowledge', { name: project.name })"
        @click="$emit('knowledge')">
        <span class="i-lucide-book-open w-3.5 h-3.5" aria-hidden="true" />
      </button>
      <button v-if="runtimeState === 'failed'" class="project-settings retry-runtime" :disabled="retrying" :aria-label="t('Retry {name} startup', { name: project.name })" :title="t('Retry project startup')" @click="retryRuntime"><span class="i-lucide-refresh-cw w-3.5 h-3.5" aria-hidden="true" /></button>
      <RouterLink class="project-settings" :aria-label="t('{name} settings', { name: project.name })" :title="t('{name} settings', { name: project.name })"
        :to="{ name: 'project-settings', params: { projectId: project.id, section: 'general' } }">
        <span class="i-lucide-settings-2 w-3.5 h-3.5" aria-hidden="true" />
      </RouterLink>
      <SessionDeleteDialog v-if="deletion" :target="deletion" @close="deletion = undefined" @deleted="sessionsDeleted" />
    </template>
  </FoldersSidebar>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, inject, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useServiceGroups, projectGroupConversations, observedGroupId } from '../service-groups.ts'
import FoldersSidebar from './FoldersSidebar.vue'
import SessionDeleteDialog from './SessionDeleteDialog.vue'
import type { SessionDeletionTarget } from '../session-deletion.ts'
import { projectBase } from '../api-url.ts'
import { createProjectsClient, type ProjectRecord, type ProjectRuntimeStatus } from '../projects.ts'
import { automationSessionOwners, type SidebarSession } from '../folders-sidebar.ts'
import type { FolderRecord } from '../folders-client.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import type { ProjectLiveLease } from '../project-live-state.ts'
import { HomeTreeCacheKey } from '../home-tree-cache.ts'
import { createBotSettingsClient } from '../bot-settings.ts'
import type { SidebarBot } from '../bot-sidebar.ts'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import { createLiveResourceRefresh } from '../live-resource-refresh.ts'

const props = withDefaults(defineProps<{
  apiBase: string; project: ProjectRecord; selectedProjectId: string; selectedSessionId: string
  navigationKey: string
  dashboardSelected?: boolean
  draftFolderId?: string; remoteFolders: boolean
  folderRevision?: number
  selectedAutomationId?: string
}>(), { dashboardSelected: true })
const emit = defineEmits<{ select: [id: string]; draft: [folder?: FolderRecord, remote?: boolean]; deleted: [id: string]; manage: [folder: FolderRecord, action: 'remove' | 'move']; automation: [id: string]; knowledge: []; dashboard: []; 'session-automation': [sessionId: string, jobId?: string] }>()
const scope = computed(() => projectBase(props.apiBase, props.project.id))
const liveState = useProjectLiveState()
const livePool = useLiveClientPool()
const homeCache = inject(HomeTreeCacheKey, undefined)
const sessions = ref<SidebarSession[]>([])
const bots = ref<SidebarBot[]>([])
const liveFolderRevision = ref(0)
const stages = ref<Record<string, string>>({})
const collapsed = reactive(new Set<string>())
const loading = ref(true)
const error = ref('')
const runtimeState = ref<ProjectRuntimeStatus['state']>()
const retrying = ref(false)
const { groups: observedGroups } = useServiceGroups(() => ({ apiBase: scope.value, projectId: props.project.id, active: runtimeState.value === 'ready' }))
const displayBots = computed(() => {
  const catalog = [...bots.value]
  for (const group of observedGroups.value) {
    if (!catalog.some(bot => bot.id === group.botInstanceId && bot.projectId === props.project.id))
      catalog.push({ id: group.botInstanceId, projectId: props.project.id, platform: group.platform, displayName: group.botName })
  }
  return catalog
})
const displaySessions = computed(() => projectGroupConversations(sessions.value, observedGroups.value, props.project.id))
const deletion = ref<SessionDeletionTarget>()
watch(() => [displaySessions.value, props.selectedSessionId, props.selectedProjectId], () => {
  if (props.selectedProjectId !== props.project.id) return
  const session = displaySessions.value.find(s => s.groupObservation && s.sessionId !== props.selectedSessionId && observedGroupId(s.groupObservation) === props.selectedSessionId)
  if (session) emit('select', session.sessionId)
})
watch(() => [sessions.value, loading.value, props.selectedProjectId, props.selectedSessionId, props.selectedAutomationId] as const, () => {
  if (props.selectedProjectId !== props.project.id || !props.selectedSessionId || loading.value) return
  if (!sessions.value.some(session => session.sessionId === props.selectedSessionId)) return
  emit('session-automation', props.selectedSessionId, automationSessionOwners(sessions.value).get(props.selectedSessionId)?.jobId)
})
let controller: AbortController | undefined
const lifetime = new AbortController()
let lease: ProjectLiveLease | undefined
let stopWatching: (() => void) | undefined
let active = true
let disposed = false
function toggle(id: string) { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id) }
function subscribe() {
  const current = lease = liveState.acquireProject(props.apiBase, props.project.id)
  const stopGraph = watch(() => [current.graph.state.revision, current.graph.state.error], () => {
    if (current.graph.state.value) {
      sessions.value = current.graph.state.value
      homeCache?.setSessions(scope.value, sessions.value)
    }
  }, { immediate: true })
  const stopActivity = watch(() => [current.activity.state.revision, current.activity.state.error], () => {
    if (current.activity.state.value) stages.value = current.activity.state.value.stages
    const detail = [...new Set([current.graph.state.error, current.activity.state.error].filter(Boolean))].join(' ')
    error.value = detail && runtimeState.value === 'failed'
      ? t('This project could not start. Use Retry project startup beside its name.') : detail
  }, { immediate: true })
  // Session graph revisions (including turn start/end) are not catalog changes.
  const stopMetadata = watch([() => !!current.graph.state.value,
    () => !!current.graph.state.value?.some(session => session.channelAddress), () => current.graph.state.error], () => {
    if (current.graph.state.value || current.graph.state.error) void refreshMetadata(current)
  }, { immediate: true })
  let initialCatalog = true
  const catalog = createLiveResourceRefresh(livePool, {
    base: props.apiBase, projectId: props.project.id, resource: 'channels',
    refresh: () => {
      // Graph readiness owns the first snapshot; do not duplicate it at resource ready.
      if (initialCatalog) { initialCatalog = false; return }
      void refreshMetadata(current)
    },
  })
  stopWatching = () => { stopGraph(); stopActivity(); stopMetadata(); catalog.dispose() }
}
async function refresh() {
  liveFolderRevision.value++
  await lease?.refresh()
  if (lease) await refreshMetadata(lease)
}
async function refreshMetadata(snapshot: ProjectLiveLease) {
  if (disposed || !active) return
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    if (!snapshot.graph.state.error && sessions.value.some(session => session.channelAddress)) {
      try {
        const catalog = await createBotSettingsClient(scope.value, props.project.id).list(current.signal)
        if (current.signal.aborted) return
        bots.value = catalog.map(({ id, projectId, platform, displayName, state, configured }) =>
          ({ id, projectId, platform, displayName, connection: { state, configured } }))
      } catch {
        // Bot settings may be unavailable to a conversation reader; retain scoped names and usable chats.
        if (current.signal.aborted) return
        clearBotConnections()
      }
    } else if (snapshot.graph.state.error) clearBotConnections()
    error.value = [...new Set([snapshot.graph.state.error, snapshot.activity.state.error].filter(Boolean))].join(' ')
    if (error.value) {
      try {
        const status = await createProjectsClient(props.apiBase).status(props.project.id, current.signal)
        if (!current.signal.aborted) {
          runtimeState.value = status.state
          if (status.state === 'failed') error.value = t('This project could not start. Use Retry project startup beside its name.')
        }
      } catch (cause) {
        if (!current.signal.aborted) error.value += ` ${cause instanceof Error ? cause.message : t('Runtime status is unavailable.')}`
      }
    } else runtimeState.value = 'ready'
  } finally {
    if (controller === current) {
      controller = undefined
      loading.value = false
    }
  }
}
async function retryRuntime() {
  if (retrying.value || disposed) return
  retrying.value = true
  try {
    const status = await createProjectsClient(props.apiBase).retry(
      props.project.id, AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
    )
    if (disposed) return
    runtimeState.value = status.state
    await refresh()
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : t('Could not retry project startup. Check Main.')
  } finally { retrying.value = false }
}
function deleteSession(id: string) {
  if (deletion.value) return
  deletion.value = { apiBase: scope.value, sessionId: id, name: sessions.value.find(session => session.sessionId === id)?.label || id, projectName: props.project.name }
}
async function sessionsDeleted(ids: string[]) {
  deletion.value = undefined
  for (const id of ids) emit('deleted', id)
  await refresh()
}
function stop() {
  clearBotConnections()
  stopWatching?.()
  stopWatching = undefined
  lease?.release()
  lease = undefined
  controller?.abort()
  controller = undefined
}
function clearBotConnections() {
  bots.value = bots.value.map(({ connection: _connection, ...bot }) => bot)
}
onMounted(subscribe)
onActivated(() => {
  if (active) return
  active = true
  subscribe()
})
onDeactivated(() => { active = false; stop() })
watch(() => props.folderRevision, () => { void refresh() })
watch(() => [props.apiBase, props.project.id], () => {
  deletion.value = undefined
  stop()
  sessions.value = []
  bots.value = []
  stages.value = {}
  error.value = ''
  loading.value = true
  if (active) subscribe()
})
onUnmounted(() => { disposed = true; stop(); lifetime.abort() })
</script>

<style scoped>
.project-entry { display: block; width: 100%; min-width: 0; min-height: var(--sidebar-row-height); padding: 0; border: 0; background: transparent; color: var(--c-text); text-align: left; font: inherit; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.project-entry.selected { color: var(--c-primary); text-decoration: underline; text-underline-offset: 4px; }
.project-entry:hover { color: var(--c-primary); }
.project-entry:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.project-settings { display: grid; place-items: center; flex-shrink: 0; width: var(--sidebar-action-size); height: var(--sidebar-action-size); padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); }
.project-settings:hover { background: var(--c-bg-muted); color: var(--c-text); }
.project-settings:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.retry-runtime { padding: 0; border: 0; background: transparent; color: var(--c-error); }
</style>
