<template>
  <FoldersSidebar :api-base="scope" grouped :project-name="project.name"
    :selected-automation-id="selectedProjectId === project.id ? selectedAutomationId : undefined"
    :folder-revision="(folderRevision ?? 0) + liveFolderRevision"
    :sessions="sessions" :active-session-id="selectedProjectId === project.id ? selectedSessionId : ''"
    :draft-folder-id="selectedProjectId === project.id ? draftFolderId : undefined"
    :collapsed="collapsed" :stages="stages" :sessions-loading="loading" :sessions-error="error"
    :remote-folders="remoteFolders" @select="$emit('select', $event)" @delete="deleteSession"
    @toggle="toggle" @reload="refresh" @scratch="$emit('draft')" @remote="$emit('draft', undefined, true)" @draft="$emit('draft', $event)"
    @manage="(folder, action) => $emit('manage', folder, action)" @automation="$emit('automation', $event)">
    <template #project-entry>
      <ProjectCoordinator :api-base="apiBase" :project-id="project.id" :project-name="project.name"
        :selected="selectedProjectId === project.id && selectedSessionId === ORCHESTRATOR_SESSION_ID"
        :navigation-key="navigationKey" :pending-project-id="pendingCoordinatorProjectId"
        @opening="$emit('coordinator-opening')" @open="$emit('select', $event)" />
    </template>
    <template #project-actions>
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
import { createProjectsClient, fetchProjectConversations, type ProjectRecord, type ProjectRuntimeStatus } from '../projects.ts'
import { automationSessionOwners, type SidebarSession } from '../folders-sidebar.ts'
import type { FolderRecord } from '../folders-client.ts'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import type { LiveSubscription } from '../live-client.ts'
import { HomeTreeCacheKey } from '../home-tree-cache.ts'

const props = defineProps<{
  apiBase: string; project: ProjectRecord; selectedProjectId: string; selectedSessionId: string
  navigationKey: string
  pendingCoordinatorProjectId?: string
  draftFolderId?: string; remoteFolders: boolean
  folderRevision?: number
  selectedAutomationId?: string
}>()
const emit = defineEmits<{ select: [id: string]; draft: [folder?: FolderRecord, remote?: boolean]; deleted: [id: string]; manage: [folder: FolderRecord, action: 'remove' | 'move']; automation: [id: string]; 'session-automation': [sessionId: string, jobId?: string]; 'coordinator-opening': [] }>()
const scope = computed(() => projectBase(props.apiBase, props.project.id))
const livePool = useLiveClientPool()
const homeCache = inject(HomeTreeCacheKey, undefined)
const sessions = ref<SidebarSession[]>([])
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
let timer: ReturnType<typeof setTimeout> | undefined
let invalidationTimer: ReturnType<typeof setTimeout> | undefined
let subscription: LiveSubscription | undefined
let dirty = false
let active = true
let disposed = false
function toggle(id: string) { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id) }
function invalidate() {
  dirty = true
  if (!active || disposed || controller || invalidationTimer !== undefined) return
  invalidationTimer = setTimeout(() => { invalidationTimer = undefined; void refresh() }, 250)
}
function subscribe() {
  subscription?.close()
  subscription = livePool.client(props.apiBase).subscribe({ kind: 'sessions', projectId: props.project.id }, {
    event: invalidate, reset: invalidate,
  })
}
async function refresh() {
  clearTimeout(timer)
  if (controller) { dirty = true; return }
  if (disposed || !active) return
  if (dirty) liveFolderRevision.value++
  dirty = false
  const current = new AbortController()
  controller = current
  try {
    const next = await fetchProjectConversations(props.apiBase, props.project.id, current.signal)
    if (current.signal.aborted) return
    if (!next.sessionsError) {
      sessions.value = next.sessions
      homeCache?.setSessions(scope.value, next.sessions)
    }
    if (!next.stagesError) stages.value = next.stages
    error.value = [...new Set([next.sessionsError, next.stagesError].filter(Boolean))].join(' ')
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
      if (!disposed && active) {
        if (dirty) invalidate()
        else timer = setTimeout(refresh, 20_000)
      }
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
  subscription?.close()
  subscription = undefined
  clearTimeout(timer)
  clearTimeout(invalidationTimer)
  invalidationTimer = undefined
  controller?.abort()
  controller = undefined
}
onMounted(() => { subscribe(); void refresh() })
onActivated(() => {
  if (active) return
  active = true
  subscribe()
  void refresh()
})
onDeactivated(() => { active = false; stop() })
watch(() => props.folderRevision, () => { void refresh() })
watch(() => [props.apiBase, props.project.id], () => {
  deletion.value = undefined
  stop()
  sessions.value = []
  stages.value = {}
  error.value = ''
  loading.value = true
  if (active) { subscribe(); void refresh() }
})
onUnmounted(() => { disposed = true; stop(); lifetime.abort() })
</script>

<style scoped>
.project-settings { display: grid; place-items: center; width: 28px; height: 28px; color: var(--c-text-secondary); }
.project-settings:hover { background: var(--c-bg-muted); color: var(--c-text); }
.project-settings:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.retry-runtime { padding: 0; border: 0; background: transparent; color: var(--c-error); }
</style>
