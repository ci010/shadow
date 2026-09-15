<template>
  <ProjectsSidebar :api-base="scope" grouped :organization-name="organization.name"
    :project-revision="projectRevision"
    :sessions="sessions" :active-session-id="selectedOrganizationId === organization.id ? selectedSessionId : ''"
    :draft-project-id="selectedOrganizationId === organization.id ? draftProjectId : undefined"
    :collapsed="collapsed" :stages="stages" :sessions-loading="loading" :sessions-error="error"
    :remote-folders="remoteFolders" @select="$emit('select', $event)" @delete="deleteSession"
    @toggle="toggle" @reload="refresh" @scratch="$emit('draft')" @remote="$emit('draft', undefined, true)" @draft="$emit('draft', $event)"
    @manage="(project, action) => $emit('manage', project, action)">
    <template #organization-actions>
      <button v-if="runtimeState === 'failed'" class="organization-settings retry-runtime" :disabled="retrying" :aria-label="`Retry ${organization.name} startup`" title="Retry organization startup" @click="retryRuntime"><span class="i-lucide-refresh-cw w-3.5 h-3.5" aria-hidden="true" /></button>
      <RouterLink class="organization-settings" :aria-label="`${organization.name} settings`" :title="`${organization.name} settings`"
        :to="{ name: 'organization-settings', params: { organizationId: organization.id, section: 'general' } }">
        <span class="i-lucide-settings-2 w-3.5 h-3.5" aria-hidden="true" />
      </RouterLink>
    </template>
  </ProjectsSidebar>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import ProjectsSidebar from './ProjectsSidebar.vue'
import { apiUrl, organizationBase } from '../api-url.ts'
import { createOrganizationsClient, fetchOrganizationConversations, type OrganizationRecord, type OrganizationRuntimeStatus } from '../organizations.ts'
import type { SidebarSession } from '../projects-sidebar.ts'
import type { ProjectRecord } from '../projects-client.ts'

const props = defineProps<{
  apiBase: string; organization: OrganizationRecord; selectedOrganizationId: string; selectedSessionId: string
  draftProjectId?: string; remoteFolders: boolean
  projectRevision?: number
}>()
const emit = defineEmits<{ select: [id: string]; draft: [project?: ProjectRecord, remote?: boolean]; deleted: [id: string]; manage: [project: ProjectRecord, action: 'remove' | 'move'] }>()
const scope = organizationBase(props.apiBase, props.organization.id)
const sessions = ref<SidebarSession[]>([])
const stages = ref<Record<string, string>>({})
const collapsed = reactive(new Set<string>())
const loading = ref(true)
const error = ref('')
const runtimeState = ref<OrganizationRuntimeStatus['state']>()
const retrying = ref(false)
let controller: AbortController | undefined
const lifetime = new AbortController()
let timer: ReturnType<typeof setTimeout> | undefined
let disposed = false
function toggle(id: string) { if (collapsed.has(id)) collapsed.delete(id); else collapsed.add(id) }
async function refresh() {
  clearTimeout(timer)
  if (controller || disposed) return
  const current = new AbortController()
  controller = current
  try {
    const next = await fetchOrganizationConversations(props.apiBase, props.organization.id, current.signal)
    if (current.signal.aborted) return
    if (!next.sessionsError) sessions.value = next.sessions
    if (!next.stagesError) stages.value = next.stages
    error.value = [next.sessionsError, next.stagesError].filter(Boolean).join(' ')
    if (error.value) {
      try {
        const status = await createOrganizationsClient(props.apiBase).status(props.organization.id, current.signal)
        if (!current.signal.aborted) {
          runtimeState.value = status.state
          if (status.state === 'failed') error.value = 'This organization could not start. Use Retry organization startup beside its name.'
        }
      } catch (cause) {
        if (!current.signal.aborted) error.value += ` ${cause instanceof Error ? cause.message : 'Runtime status is unavailable.'}`
      }
    } else runtimeState.value = 'ready'
  } finally {
    if (controller === current) {
      controller = undefined
      loading.value = false
      if (!disposed) timer = setTimeout(refresh, 4000)
    }
  }
}
async function retryRuntime() {
  if (retrying.value || disposed) return
  retrying.value = true
  try {
    const status = await createOrganizationsClient(props.apiBase).retry(
      props.organization.id, AbortSignal.any([lifetime.signal, AbortSignal.timeout(30_000)]),
    )
    if (disposed) return
    runtimeState.value = status.state
    await refresh()
  } catch (cause) {
    if (!disposed) error.value = cause instanceof Error ? cause.message : 'Could not retry organization startup. Check Main.'
  } finally { retrying.value = false }
}
async function deleteSession(id: string) {
  if (!confirm(`Delete "${id}" and its child sessions in ${props.organization.name}?`)) return
  try {
    const response = await fetch(apiUrl(scope, `/api/sessions/${encodeURIComponent(id)}`), { method: 'DELETE', signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)]) })
    if (!response.ok) throw new Error('Could not delete this conversation. Check Main and retry.')
    if (disposed) return
    emit('deleted', id)
    await refresh()
  } catch (cause) { if (!disposed) error.value = cause instanceof Error ? cause.message : 'Could not delete this conversation. Retry.' }
}
onMounted(refresh)
watch(() => props.projectRevision, () => { void refresh() })
onUnmounted(() => { disposed = true; clearTimeout(timer); controller?.abort(); lifetime.abort() })
</script>

<style scoped>
.organization-settings { display: grid; place-items: center; width: 28px; height: 28px; color: var(--c-text-secondary); }
.organization-settings:hover { background: var(--c-bg-muted); color: var(--c-text); }
.organization-settings:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.retry-runtime { padding: 0; border: 0; background: transparent; color: var(--c-error); }
</style>
