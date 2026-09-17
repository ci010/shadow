<template>
  <div ref="workspaceElement" class="projects-workspace">
    <button class="projects-mobile-toggle btn btn-sm" :aria-expanded="sidebarOpen" aria-controls="projects-sidebar" @click="sidebarOpen = !sidebarOpen">Projects</button>
    <button v-if="sidebarOpen" class="projects-backdrop" aria-label="Close projects" @click="sidebarOpen = false" />
    <aside id="projects-sidebar" class="projects-sidebar" :class="{ open: sidebarOpen, 'is-rail': isRail }"
      :style="{ '--projects-width': `${isRail ? 64 : sidebarWidth}px` }" aria-label="Projects">
      <SidebarResizer v-if="desktop && !isRail && visible" :model-value="sidebarWidth" :bounds="resizeBounds"
        label="Resize projects" controls="projects-sidebar" @update:model-value="preferredWidth = $event" />
      <header class="projects-heading">
        <h1 v-if="!isRail">Projects</h1>
        <div class="projects-heading-actions">
          <HoverInfo v-if="desktop" :text="isRail ? 'Expand projects' : 'Collapse projects'"><template #default="{ triggerProps }">
            <button class="project-add projects-rail-toggle" v-bind="triggerProps" :aria-label="isRail ? 'Expand projects' : 'Collapse projects'"
              :aria-expanded="!isRail" aria-controls="project-groups" @click="railCollapsed = !railCollapsed">
              <span :class="isRail ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="w-4 h-4" aria-hidden="true" />
            </button>
          </template></HoverInfo>
          <button v-if="!isRail" class="project-add" aria-label="Add project" :aria-expanded="creating" @click="creating = !creating"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
        </div>
      </header>
      <nav v-if="isRail" class="project-rail" aria-label="Project shortcuts">
        <HoverInfo v-for="project in projects" :key="project.id" :text="project.name"><template #default="{ triggerProps }">
          <button class="project-badge" v-bind="triggerProps" :class="{ selected: selectedProjectId === project.id }"
            :aria-label="`Show ${project.name} folders`" @click="showProject(project.id)">{{ railInitial(project.name) }}</button>
        </template></HoverInfo>
        <HoverInfo text="Add project"><template #default="{ triggerProps }">
          <button class="project-badge project-rail-add" v-bind="triggerProps" aria-label="Add project" @click="railCollapsed = false; creating = true"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
        </template></HoverInfo>
        <button v-if="error" class="project-badge project-error" aria-label="Projects unavailable. Retry catalog" @click="refresh"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button>
      </nav>
      <form v-if="creating && !isRail" class="project-create" @submit.prevent="createProject">
        <label>Project name<input v-model="name" required autocomplete="off" :disabled="saving" /></label>
        <button class="btn btn-sm" :disabled="saving || !name.trim()">{{ saving ? 'Creating...' : 'Create project' }}</button>
      </form>
      <p v-if="loading && !isRail" class="project-note" role="status">Loading projects...</p>
      <div v-if="error && !isRail" class="project-note project-error" role="alert"><p>{{ error }}</p><button class="btn btn-sm" @click="refresh">Retry catalog</button></div>
      <div v-show="!isRail" id="project-groups" class="project-groups">
        <ProjectGroup v-for="project in projects" :key="project.id" :api-base="apiBase" :project="project"
          :data-project-id="project.id" :folder-revision="folderRevision"
          :navigation-key="`${route.fullPath}:${visible}`"
          :pending-coordinator-project-id="pendingCoordinatorProjectId" @coordinator-opening="pendingCoordinatorProjectId = project.id"
          :selected-project-id="selectedProjectId" :selected-session-id="selected?.sessionId ?? ''" :selected-automation-id="automation?.id"
          :draft-folder-id="selected?.folder?.id" :remote-folders="installation.mode === 'main'"
          @select="selectSession(project.id, $event)" @draft="(folder, remote) => startDraft(project.id, folder, remote)"
          @deleted="deleted(project.id, $event)" @manage="(folder, action) => manageFolder(project, folder, action)"
          @automation="showAutomation(project.id, $event)" @session-automation="(session, job) => identifyAutomation(project.id, session, job)" />
      </div>
      <p v-if="notice && !isRail" class="project-notice" role="status">{{ notice }}</p>
    </aside>
    <div class="project-conversations">
      <AutomationDetail v-if="automation" :key="`${automation.projectId}:${automation.id}`"
        :api-base="projectBase(apiBase, automation.projectId)" :automation-id="automation.id" :active="visible"
        :compact="!!selected?.sessionId" :selected-session-id="selected?.sessionId"
        @open="openAutomationRun" @overview="showAutomation(automation.projectId, automation.id)" />
      <section v-if="!selected && !automation" class="project-empty">
        <h1>Where would you like to work?</h1>
        <p>Choose a folder or start a chat in a project. Each project keeps its own Home and model defaults.</p>
        <button v-for="project in projects" :key="project.id" class="btn" @click="startDraft(project.id)">Start in {{ project.name }}</button>
        <button v-if="!projects.length && !loading && !error" class="btn" @click="creating = true">Create a project</button>
      </section>
      <ProjectConversation v-for="resource in resources" :key="resource.key"
        :ref="component => setConversation(resource.key, component)"
        v-show="selected?.key === resource.key" :visible="visible && selected?.key === resource.key"
        :api-base="projectBase(apiBase, resource.projectId)" :project-id="resource.projectId"
        :project-name="projects.find(item => item.id === resource.projectId)?.name ?? resource.projectId"
        :session-id="resource.sessionId" :initial-folder="resource.folder" :open-remote="resource.openRemote"
        :child-session-id="resource.childSessionId"
        @navigate="(id, child) => navigate(resource.projectId, id, child)" @prepared="prepared(resource.key, $event)" />
    </div>
    <FolderOwnershipDialog v-if="folderOperation" :key="`${folderOperation.project.id}:${folderOperation.folder.id}:${folderOperation.action}`"
      :api-base="apiBase" :project="folderOperation.project" :projects="projects"
      :folder="folderOperation.folder" :action="folderOperation.action" @close="folderOperation = undefined"
      @refresh="folderOperation = undefined; folderRevision++" @changed="folderChanged" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, provide, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProjectGroup from './ProjectGroup.vue'
import ProjectConversation from './ProjectConversation.vue'
import FolderOwnershipDialog from './FolderOwnershipDialog.vue'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import AutomationDetail from './AutomationDetail.vue'
import { projectBase } from '../api-url.ts'
import { createProjectsClient, projectChatLocation, type ProjectRecord } from '../projects.ts'
import { createConversationResources, type ConversationResource } from '../project-workspaces.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import type { FolderRecord } from '../folders-client.ts'
import { railInitial } from '../folder-rail.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { DEFAULT_PROJECT_SIDEBAR, projectSidebarStorageKey, restoreProjectSidebarPreferences } from '../project-sidebar.ts'
import { createHomeTreeCache, HomeTreeCacheKey } from '../home-tree-cache.ts'
import { useAutomationNavigation } from '../composables/useAutomationNavigation.ts'

defineOptions({ name: 'ProjectsWorkspace' })
const props = withDefaults(defineProps<{ apiBase: string; visible?: boolean }>(), { visible: true })
const route = useRoute()
const router = useRouter()
const installation = useInstallationContext()
provide(HomeTreeCacheKey, createHomeTreeCache())
const projects = ref<ProjectRecord[]>([])
const registry = createConversationResources()
const resources = shallowRef<ConversationResource[]>([])
const selected = shallowRef<ConversationResource>()
const pendingCoordinatorProjectId = ref('')
const { automation, syncAutomationRoute, showAutomation, openAutomationRun, identifyAutomation } = useAutomationNavigation({
  route, router, selected,
  openSession: session => publish(registry.session(session)),
  closeSidebar: () => { sidebarOpen.value = false },
})
const selectedProjectId = computed(() => automation.value?.projectId ?? selected.value?.projectId ?? '')
const instances = new Map<string, InstanceType<typeof ProjectConversation>>()
const sidebarOpen = ref(false)
const creating = ref(false)
const name = ref('')
const saving = ref(false)
const loading = ref(true)
const error = ref('')
const workspaceElement = ref<HTMLElement>()
const desktop = ref(false)
const railCollapsed = ref(false)
const preferredWidth = ref(DEFAULT_PROJECT_SIDEBAR.width)
const containerWidth = ref(800)
const isRail = computed(() => desktop.value && railCollapsed.value)
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 200, 440))
const sidebarWidth = computed(() => clampSidebarWidth(preferredWidth.value, resizeBounds.value))
const storageKey = projectSidebarStorageKey(props.apiBase)
let sidebarObserver: ResizeObserver | undefined
const folderRevision = ref(0)
const notice = ref('')
const folderOperation = shallowRef<{ project: ProjectRecord; folder: FolderRecord; action: 'remove' | 'move' }>()
let request: AbortController | undefined
let mutation: AbortController | undefined
function measureSidebar() {
  desktop.value = window.innerWidth > 700
  const width = workspaceElement.value?.getBoundingClientRect().width
  if (width) containerWidth.value = width
}
async function showProject(id: string) {
  railCollapsed.value = false
  await nextTick()
  const group = [...(workspaceElement.value?.querySelectorAll<HTMLElement>('[data-project-id]') ?? [])]
    .find(element => element.dataset.projectId === id)
  const toggle = group?.querySelector<HTMLButtonElement>('.project-toggle')
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    toggle.click()
    await nextTick()
  }
  group?.scrollIntoView({ block: 'nearest' })
  toggle?.focus({ preventScroll: true })
}
function manageFolder(project: ProjectRecord, folder: FolderRecord, action: 'remove' | 'move') {
  folderOperation.value = { project, folder, action }
}
function folderChanged(folder?: FolderRecord) {
  const operation = folderOperation.value
  if (!operation) return
  const target = projects.value.find(org => org.id === folder?.projectId)
  notice.value = folder ? `${operation.folder.name} moved to ${target?.name ?? folder.projectId}.`
    : `${operation.folder.name} removed from ${operation.project.name}.`
  notice.value += ' Files are unchanged; existing conversations remain in the original project.'
  folderOperation.value = undefined
  folderRevision.value++
  void showProject(operation.project.id)
}
function setConversation(key: string, component: Element | ComponentPublicInstance | null) {
  if (component) instances.set(key, component as InstanceType<typeof ProjectConversation>)
  else instances.delete(key)
}
function publish(resource: ConversationResource) {
  selected.value = resource
  resources.value = [...registry.resources]
  sidebarOpen.value = false
}
function syncRoute() {
  if (!props.visible || route.name !== 'chat') return
  const projectId = typeof route.params.projectId === 'string' ? route.params.projectId : ''
  if (!projectId || !projects.value.some(org => org.id === projectId)) {
    selected.value = undefined
    automation.value = undefined
    if (projectId && !loading.value) error.value = 'This project is unavailable. Refresh the catalog or choose another project.'
    return
  }
  const automationId = syncAutomationRoute(projectId)
  const sessionId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  if (sessionId) {
    const resource = registry.session({ projectId, sessionId })
    resource.childSessionId = typeof route.query.child === 'string' ? route.query.child : undefined
    publish(resource)
  }
  else if (automationId) { selected.value = undefined; sidebarOpen.value = false }
  else if (selected.value?.projectId !== projectId || selected.value.sessionId) publish(registry.draft(projectId))
}
async function refresh() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const result = await createProjectsClient(props.apiBase).list(controller.signal)
    if (controller.signal.aborted) return
    projects.value = result
    syncRoute()
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load projects. Retry.'
  } finally { if (request === controller) { loading.value = false; request = undefined } }
}
async function createProject() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const controller = new AbortController()
  mutation = controller
  try {
    const project = await createProjectsClient(props.apiBase).save(name.value, undefined, controller.signal)
    if (controller.signal.aborted) return
    projects.value.push(project)
    name.value = ''
    creating.value = false
    startDraft(project.id)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not create project. Retry.'
  } finally { saving.value = false }
}
function startDraft(projectId: string, folder?: FolderRecord, remote = false) {
  automation.value = undefined
  const resource = registry.draft(projectId, folder, remote)
  publish(resource)
  void router.push(projectChatLocation(resource))
}
function navigate(projectId: string, sessionId: string, child?: string) {
  automation.value = undefined
  if (!sessionId) { startDraft(projectId); return }
  const resource = registry.session({ projectId, sessionId })
  resource.childSessionId = child
  publish(resource)
  void router.push({ ...projectChatLocation({ projectId, sessionId }), query: child ? { child } : {} })
}
function selectSession(projectId: string, sessionId: string) {
  if (selected.value?.projectId === projectId) {
    const instance = instances.get(selected.value.key)
    if (instance) { instance.requestSession(sessionId); sidebarOpen.value = false; return }
  }
  navigate(projectId, sessionId)
}
function prepared(key: string, sessionId: string) {
  const resource = registry.prepared(key, sessionId)
  resources.value = [...registry.resources]
  // A delayed upload/prepare in A must not navigate away from B.
  if (selected.value?.key === key && props.visible && route.name === 'chat') {
    void router.replace({ ...projectChatLocation(resource), query: resource.childSessionId ? { child: resource.childSessionId } : {} })
  }
}
function deleted(projectId: string, sessionId: string) {
  for (let i = registry.resources.length - 1; i >= 0; i--) {
    const resource = registry.resources[i]
    if (resource.projectId === projectId && resource.sessionId === sessionId) registry.resources.splice(i, 1)
  }
  resources.value = [...registry.resources]
  if (selected.value?.projectId === projectId && selected.value.sessionId === sessionId) startDraft(projectId)
}
watch(() => [route.fullPath, props.visible], syncRoute)
watch([preferredWidth, railCollapsed], ([width, collapsed]) => {
  try { window.localStorage.setItem(storageKey, JSON.stringify({ width, collapsed })) }
  catch { console.warn('[projects] Could not save sidebar preferences; layout will reset after reload.') }
})
const onCatalogChanged = () => { void refresh() }
onMounted(() => {
  try {
    const preferences = restoreProjectSidebarPreferences(window.localStorage, props.apiBase)
    preferredWidth.value = preferences.width
    railCollapsed.value = preferences.collapsed
  } catch { console.warn('[projects] Could not restore sidebar preferences; using the default layout.') }
  sidebarObserver = new ResizeObserver(measureSidebar)
  if (workspaceElement.value) sidebarObserver.observe(workspaceElement.value)
  measureSidebar()
  void refresh()
  window.addEventListener('resize', measureSidebar)
  window.addEventListener('shadow:projects-changed', onCatalogChanged)
})
onUnmounted(() => {
  request?.abort(); mutation?.abort(); sidebarObserver?.disconnect()
  window.removeEventListener('resize', measureSidebar)
  window.removeEventListener('shadow:projects-changed', onCatalogChanged)
})
</script>

<style scoped>
.projects-workspace { display: flex; position: relative; flex: 1; min-width: 0; min-height: 0; height: 100%; }
.projects-sidebar { position: relative; display: flex; flex-direction: column; flex: 0 0 var(--projects-width, 270px); width: var(--projects-width, 270px); min-width: 0; min-height: 0; border-right: 1px solid var(--c-border); background: var(--c-bg-card); }
.projects-heading { display: flex; align-items: center; justify-content: space-between; padding: 16px; }
.projects-heading h1 { margin: 0; min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.projects-heading-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; }
.project-add { display: grid; place-items: center; border: 0; width: 28px; height: 28px; padding: 0; color: var(--c-text); background: transparent; }
.project-add:hover { background: var(--c-bg-muted); }
.project-groups { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.is-rail .projects-heading { justify-content: center; padding: 12px 0; }
.is-rail .projects-rail-toggle { width: 40px; height: 36px; }
.project-rail { display: flex; flex: 1; min-height: 0; overflow-y: auto; align-items: center; flex-direction: column; gap: 12px; padding: 4px 8px 16px; }
.project-badge { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: 0; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-muted); font: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
.project-badge:hover { background: var(--c-bg-soft); }
.project-badge.selected { background: var(--c-selection-bg); border-color: var(--c-blue); }
.project-rail-add { color: var(--c-text-secondary); background: transparent; }
.project-notice { margin: 0; padding: 12px 16px; border-top: 1px solid var(--c-border); font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.project-conversations { display: flex; flex-direction: column; flex: 1; min-width: 0; min-height: 0; }
.project-empty { align-self: center; margin: auto; padding: 24px; max-width: 560px; }
.project-empty h1 { font-size: 24px; }
.project-empty p { color: var(--c-text-secondary); line-height: 1.6; }
.project-empty .btn { display: block; margin: 12px 0; }
.project-note, .project-create { margin: 0; padding: 12px 16px; font-size: 13px; }
.project-error { color: var(--c-error); overflow-wrap: anywhere; }
.project-create label { display: grid; gap: 8px; margin-bottom: 10px; }
.project-create input { width: 100%; min-width: 0; padding: 8px; border: 1px solid var(--c-border); color: var(--c-text); background: var(--c-bg-input); font: inherit; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.projects-mobile-toggle, .projects-backdrop { display: none; }
@media (max-width: 700px) {
  .projects-workspace { padding-top: 42px; }
  .projects-mobile-toggle { display: block; position: absolute; top: 4px; left: 8px; min-height: 34px; }
  .projects-sidebar { display: none; position: absolute; inset: 42px auto 0 0; z-index: 50; width: min(300px, calc(100% - 40px)); }
  .projects-sidebar.open { display: flex; }
  .projects-backdrop { display: block; position: absolute; inset: 42px 0 0; z-index: 49; border: 0; background: var(--c-shadow); }
}
</style>
