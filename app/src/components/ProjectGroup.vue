<template>
  <FoldersSidebar :api-base="scope" grouped :project-id="project.id" :project-name="project.name" :bots="bots"
    :selected-automation-id="selectedProjectId === project.id ? selectedAutomationId : undefined"
    :folder-revision="(folderRevision ?? 0) + liveFolderRevision"
    :sessions="sessions" :active-session-id="selectedProjectId === project.id ? selectedSessionId : ''"
    :draft-folder-id="selectedProjectId === project.id ? draftFolderId : undefined"
    :collapsed="collapsed" :stages="stages" :sessions-loading="loading" :sessions-error="error"
    :remote-folders="remoteFolders" @select="$emit('select', $event)" @delete="deleteSession"
    @toggle="toggle" @reload="refresh" @scratch="$emit('draft')" @remote="$emit('draft', undefined, true)" @draft="$emit('draft', $event)"
    @manage="(folder, action) => $emit('manage', folder, action)" @automation="$emit('automation', $event)">
    <template #project-name>
      <ProjectCoordinator :api-base="apiBase" :project-id="project.id" :project-name="project.name"
        :selected="selectedProjectId === project.id && selectedSessionId === ORCHESTRATOR_SESSION_ID"
        :navigation-key="navigationKey" :pending-project-id="pendingCoordinatorProjectId"
        @opening="$emit('coordinator-opening')" @open="$emit('select', $event)" />
    </template>
    <template #project-actions>
      <button v-if="canManageKnowledge" class="project-settings" :aria-label="`${project.name} knowledge`" :title="`${project.name} knowledge`"
        @click="$emit('knowledge')">
        <span class="i-lucide-book-open w-3.5 h-3.5" aria-hidden="true" />
      </button>
      <button v-if="runtimeState === 'failed'" class="project-settings retry-runtime" :disabled="retrying" :aria-label="`Retry ${project.name} startup`" title="Retry project startup" @click="retryRuntime"><span class="i-lucide-refresh-cw w-3.5 h-3.5" aria-hidden="true" /></button>
      <RouterLink class="project-settings" :aria-label="`${project.name} settings`" :title="`${project.name} settings`"
        :to="{ name: 'project-settings', params: { projectId: project.id, section: 'general' } }">
        <span class="i-lucide-settings-2 w-3.5 h-3.5" aria-hidden="true" />
      </RouterLink>
      <SessionDeleteDialog v-if="deletion" :target="deletion" @close="deletion = undefined" @deleted="sessionsDeleted" />
    </template>
  </FoldersSidebar>
</template>

<script setup lang="ts">
import { computed, inject, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import FoldersSidebar from './FoldersSidebar.vue'
import ProjectCoordinator from './ProjectCoordinator.vue'
import { ORCHESTRATOR_SESSION_ID } from '../project-coordination.ts'
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
import { useInstallationContext } from '../composables/useInstallationContext.ts'

const props = defineProps<{
  apiBase: string; project: ProjectRecord; selectedProjectId: string; selectedSessionId: string
  navigationKey: string
  pendingCoordinatorProjectId?: string
  draftFolderId?: string; remoteFolders: boolean
  folderRevision?: number
  selectedAutomationId?: string
}>()
const emit = defineEmits<{ select: [id: string]; draft: [folder?: FolderRecord, remote?: boolean]; deleted: [id: string]; manage: [folder: FolderRecord, action: 'remove' | 'move']; automation: [id: string]; knowledge: []; 'session-automation': [sessionId: string, jobId?: string]; 'coordinator-opening': [] }>()
const scope = computed(() => projectBase(props.apiBase, props.project.id))
const installation = useInstallationContext()
const canManageKnowledge = computed(() => installation.value.uiScopes.includes('main:admin'))
const liveState = useProjectLiveState()
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
const deletion = ref<SessionDeletionTarget>()
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
  let seenGraph = false
  const stopGraph = watch(() => [current.graph.state.revision, current.graph.state.error], () => {
    if (current.graph.state.value) {
      if (seenGraph) liveFolderRevision.value++
      seenGraph = true
      sessions.value = current.graph.state.value
      homeCache?.setSessions(scope.value, sessions.value)
    }
    if (current.graph.state.revision || current.graph.state.error) void refreshMetadata(current)
  }, { immediate: true })
  const stopActivity = watch(() => [current.activity.state.revision, current.activity.state.error], () => {
    if (current.activity.state.value) stages.value = current.activity.state.value.stages
    const detail = [...new Set([current.graph.state.error, current.activity.state.error].filter(Boolean))].join(' ')
    error.value = detail && runtimeState.value === 'failed'
      ? 'This project could not start. Use Retry project startup beside its name.' : detail
  }, { immediate: true })
  stopWatching = () => { stopGraph(); stopActivity() }
}
async function refresh() {
  await lease?.refresh()
}
async function refreshMetadata(snapshot: ProjectLiveLease) {
  if (disposed || !active) return
  controller?.abort()
  const current = new AbortController()
  controller = current
  try {
    await snapshot.activity.read()
    if (current.signal.aborted) return
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
          if (status.state === 'failed') error.value = 'This project could not start. Use Retry project startup beside its name.'
        }
      } catch (cause) {
        if (!current.signal.aborted) error.value += ` ${cause instanceof Error ? cause.message : 'Runtime status is unavailable.'}`
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
    if (!disposed) error.value = cause instanceof Error ? cause.message : 'Could not retry project startup. Check Main.'
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
.project-settings { display: grid; place-items: center; flex-shrink: 0; width: var(--sidebar-action-size); height: var(--sidebar-action-size); padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); }
.project-settings:hover { background: var(--c-bg-muted); color: var(--c-text); }
.project-settings:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.retry-runtime { padding: 0; border: 0; background: transparent; color: var(--c-error); }
</style>
