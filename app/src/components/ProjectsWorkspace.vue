<template>
  <div ref="workspaceElement" class="projects-workspace">
    <button v-if="sidebarOpen && !sidebarPinned && !mobileIntegrated" class="projects-backdrop" tabindex="-1" :aria-label="t('Close projects')" @click="closeSidebar()" />
    <Teleport :to="mobile?.projectsTarget.value || 'body'" :disabled="!mobileIntegrated">
    <aside v-show="mobileIntegrated ? visible : sidebarVisible" id="projects-sidebar" ref="sidebarElement" class="projects-sidebar" :class="{ 'is-floating': !sidebarPinned && !mobileIntegrated, 'in-mobile-menu': mobileIntegrated }"
      :style="{ '--projects-width': `${sidebarPinned ? sidebarWidth : preferredWidth}px` }" :aria-label="t('Projects')">
      <SidebarResizer v-if="sidebarPinned && visible" :model-value="sidebarWidth" :bounds="resizeBounds"
        :label="t('Resize projects')" controls="projects-sidebar" @update:model-value="preferredWidth = $event" />
      <header class="projects-heading">
        <h1>{{ t('Projects') }}</h1>
        <div class="projects-heading-actions">
          <HoverInfo v-if="desktop" :text="sidebarPinned ? t('Hide projects') : t('Pin projects')"><template #default="{ triggerProps }">
            <button ref="pinButton" class="project-add projects-pin-toggle" v-bind="triggerProps" :aria-label="sidebarPinned ? t('Hide projects') : t('Pin projects')"
              :aria-pressed="sidebarPinned" @click="togglePinned">
              <span :class="sidebarPinned ? 'i-lucide-panel-left-close' : 'i-lucide-pin'" class="w-4 h-4" aria-hidden="true" />
            </button>
          </template></HoverInfo>
          <button ref="addProjectButton" class="project-add" :aria-label="t('Add project')" :aria-expanded="creating" :disabled="saving" @click="creating ? cancelCreateProject() : openCreateProject()"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
          <button v-if="!sidebarPinned && !mobileIntegrated" ref="closeButton" class="project-add" :aria-label="t('Close projects')" @click="closeSidebar()"><span class="i-lucide-x w-4 h-4" aria-hidden="true" /></button>
        </div>
      </header>
      <button class="session-search-trigger" aria-keyshortcuts="Control+Shift+R Meta+Shift+R" @click="openSessionSearch">
        <span class="i-lucide-search w-4 h-4" aria-hidden="true" />
        <span>{{ t('Go to session') }}</span><kbd>Ctrl+Shift+R</kbd>
      </button>
      <form v-if="creating" class="project-create" @submit.prevent="createProject" @keydown.esc.stop.prevent="cancelCreateProject">
        <label>{{ t('Project name') }}<input v-model="name" required autocomplete="off" :disabled="saving" /></label>
        <button type="button" class="btn btn-sm" :disabled="saving" @click="cancelCreateProject">{{ t('Cancel') }}</button>
        <button type="submit" class="btn btn-sm" :disabled="saving || !name.trim()">{{ saving ? t('Creating...') : t('Create project') }}</button>
      </form>
      <p v-if="loading" class="project-note" role="status">{{ t('Loading projects...') }}</p>
      <div v-if="error" class="project-note project-error" role="alert"><p>{{ error }}</p><button class="btn btn-sm" @click="refresh">{{ t('Retry catalog') }}</button></div>
      <div id="project-groups" class="project-groups">
        <ProjectGroup v-for="project in projects" :key="project.id" :api-base="apiBase" :project="project"
          :data-project-id="project.id" :folder-revision="folderRevision"
          :navigation-key="`${route.fullPath}:${visible}`"
          :selected-project-id="selectedProjectId" :selected-session-id="selected?.sessionId ?? ''" :selected-automation-id="automation?.id"
          :dashboard-selected="!!dashboardProject"
          :draft-folder-id="selected?.folder?.id" :remote-folders="(installation.mode === 'main' || installation.mainWorkspace === true)"
          @select="selectSession(project.id, $event)" @draft="(folder, remote) => startDraft(project.id, folder, remote)"
          @project-document="openProjectDocument(project.id, $event)" @knowledge="openKnowledge(project.id)" @dashboard="openDashboard(project.id)"
          @deleted="deleted(project.id, $event)" @manage="(folder, action) => manageFolder(project, folder, action)"
          @automation="showAutomation(project.id, $event)" @session-automation="(session, job) => identifyAutomation(project.id, session, job)" />
      </div>
      <p v-if="notice" class="project-notice" role="status">{{ notice }}</p>
    </aside>
    </Teleport>
    <div class="project-conversations" @focusin="contentFocused">
      <header v-if="!sidebarPinned && !mobileIntegrated" class="projects-toolbar">
        <button ref="sidebarTrigger" class="projects-toggle" :aria-expanded="sidebarOpen" aria-controls="projects-sidebar"
          :aria-label="t('Projects{value1}', { value1: selectedProjectName ? `: ${selectedProjectName}` : '' })" @click="toggleSidebar">
          <span class="i-lucide-panel-left-open w-4 h-4" aria-hidden="true" />
          <span class="projects-current-name">{{ selectedProjectName || t('Projects') }}</span>
          <span class="i-lucide-chevron-down w-3.5 h-3.5" aria-hidden="true" />
        </button>
      </header>
      <ProjectWorkbench v-if="dashboardProject" :key="dashboardProject.id"
        :api-base="projectBase(apiBase, dashboardProject.id)" :project-id="dashboardProject.id"
        :project-name="dashboardProject.name" :visible="visible"
        @navigate="navigate(dashboardProject.id, $event)" @compose="composeFromDashboard(dashboardProject.id, $event)" />
      <section v-if="!selectedProjectId && !loading" class="project-empty">
        <h1>{{ t('Where would you like to work?') }}</h1>
        <p>{{ t('Choose a folder or start a chat in a project. Each project keeps its own Home and model defaults.') }}</p>
        <button v-for="project in projects" :key="project.id" class="btn" @click="startDraft(project.id)">{{ t('Start in') }} {{ project.name }}</button>
        <button v-if="!projects.length && !error" class="btn" @click="openCreateProject">{{ t('Create a project') }}</button>
      </section>
      <AutomationDetail :enabled="!!automation && !workflowProjectId" :api-base="automation ? projectBase(apiBase, automation.projectId) : apiBase" :automation-id="automation?.id ?? ''" :active="visible" :selected-session-id="selected?.sessionId" @open="openAutomationRun">
      <EditorGroupHost v-for="project in projects" v-show="visible && selectedProjectId === project.id && !dashboardProject" :key="project.id" :project-id="project.id" :active="visible && selectedProjectId === project.id && !dashboardProject" />
      </AutomationDetail>
      <!-- Controllers stay mounted here; EditorViewHost owns their sole visible views. -->
      <div v-show="false" class="editor-resource-owners">
        <ProjectConversation v-for="resource in resources" :key="resource.key" :resource-key="resource.key"
          :ref="component => setConversation(resource.key, component)"
          :inspection="!!resource.inspection" :keyboard-active="ownerFocused(resource.key)"
          :visible="visible && selectedProjectId === resource.projectId && !dashboardProject"
          :api-base="projectBase(apiBase, resource.projectId)" :project-id="resource.projectId"
          :project-name="projects.find(item => item.id === resource.projectId)?.name ?? resource.projectId"
          :session-id="resource.sessionId" :initial-folder="resource.folder" :open-remote="resource.openRemote"
          :automation-run="!!automation && selected?.key === resource.key"
          :knowledge-request="resource.knowledgeRequest"
          @project-navigation="(tab, documentKey) => projectNavigation(resource, tab, documentKey)"
          @navigate="(id, child) => navigate(resource.projectId, id, child)" @prepared="prepared(resource.key, $event)" @deleted="deleted(resource.projectId, $event)" />
      </div>
    </div>
    <div v-show="false" :ref="setParking" />
    <template v-for="[projectId, state] in projectDocuments.projects" :key="projectId">
      <EditorViewHost v-for="tab in state.tabs" :key="tab" :descriptor="projectDescriptor(projectId, tab)" :selected="state.selected === projectTabKey(tab)" :active="visible && selectedProjectId === projectId">
        <div class="project-document-host">
          <WorkflowManager v-if="tab === 'workflows'" :api-base="projectBase(apiBase, projectId)" :project-id="projectId" :active="visible && selectedProjectId === projectId && editorGroups.visible(projectEditorId(projectId, tab))" />
          <ProjectSettings v-else :api-base="projectBase(apiBase, projectId)" :host-api-base="installation.apiBase" :project-id="projectId" />
        </div>
      </EditorViewHost>
    </template>
    <SessionQuickOpen v-if="sessionSearchOpen" :api-base="apiBase" :projects="projects"
      @close="sessionSearchOpen = false" @select="quickOpenSession" />
    <FolderOwnershipDialog v-if="folderOperation" :key="`${folderOperation.project.id}:${folderOperation.folder.id}:${folderOperation.action}`"
      :api-base="apiBase" :project="folderOperation.project" :projects="projects"
      :folder="folderOperation.folder" :action="folderOperation.action" @close="folderOperation = undefined"
      @refresh="folderOperation = undefined; folderRevision++" @changed="folderChanged" />
  </div>
</template>

<script setup lang="ts">
import { createEditorGroups, EditorGroupsKey, type EditorDescriptor } from '../editor-groups.ts'
import EditorGroupHost from './EditorGroupHost.vue'
import EditorViewHost from './EditorViewHost.vue'
import { t } from '../i18n.ts'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ProjectGroup from './ProjectGroup.vue'
import ProjectWorkbench from './ProjectWorkbench.vue'
import ProjectConversation from './ProjectConversation.vue'
import FolderOwnershipDialog from './FolderOwnershipDialog.vue'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import SessionQuickOpen from './SessionQuickOpen.vue'
import { isSessionQuickOpenShortcut } from '../session-quick-open.ts'
import AutomationDetail from './AutomationDetail.vue'
import { projectBase } from '../api-url.ts'
import { createProjectsClient, projectChatLocation, type ProjectRecord } from '../projects.ts'
import { createConversationResources, type ConversationResource } from '../project-workspaces.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import { type FolderRecord } from '../folders-client.ts'
import { createNewConversationShortcut, hasVisibleNewConversationOverlay } from '../new-conversation-shortcut.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { DEFAULT_PROJECT_SIDEBAR, projectSidebarStorageKey, restoreProjectSidebarPreferences } from '../project-sidebar.ts'
import { createHomeTreeCache, HomeTreeCacheKey } from '../home-tree-cache.ts'
import { useAutomationNavigation } from '../composables/useAutomationNavigation.ts'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import WorkflowManager from './WorkflowManager.vue'
import ProjectSettings from './ProjectSettings.vue'
import { createProjectDocuments, ProjectDocumentsKey } from '../project-documents.ts'
import { WorkflowInputReferencesKey } from '../workflow-input-references.ts'
import { projectTabKey, projectTabLabel, projectTabIcon, KNOWLEDGE_TAB_KEY, knowledgeEntryTabKey, DIAGNOSIS_TAB_KEY, type ProjectTab } from '../file-workbench.ts'

defineOptions({ name: 'ProjectsWorkspace' })
const props = withDefaults(defineProps<{ apiBase: string; visible?: boolean }>(), { visible: true })
const projectDocuments = createProjectDocuments()
provide(ProjectDocumentsKey, projectDocuments)
const editorGroups = createEditorGroups()
provide(EditorGroupsKey, editorGroups)
const projectEditorId = (projectId: string, tab: ProjectTab) => `${projectId}:project:${tab}`
function openProjectDocument(projectId: string, tab: ProjectTab) {
  const state = projectDocuments.get(projectId)
  if (!state.tabs.includes(tab)) state.tabs = [...state.tabs, tab]
  state.selected = projectTabKey(tab)
  void nextTick(() => { const descriptor = editorGroups.descriptors.get(projectEditorId(projectId, tab)); if (descriptor) editorGroups.open(descriptor) })
}
const projectDescriptorCache = new Map<string, EditorDescriptor>()
function projectDescriptor(projectId: string, tab: ProjectTab): EditorDescriptor {
  const state = projectDocuments.get(projectId)
  const id = projectEditorId(projectId, tab), previous = projectDescriptorCache.get(id)
  if (previous && previous.label === projectTabLabel(tab)) return previous
  const descriptor: EditorDescriptor = { id, projectId, owner: projectId, label: projectTabLabel(tab), icon: projectTabIcon(tab), closable: true,
    select: () => { state.selected = projectTabKey(tab) },
    close: () => { state.tabs = state.tabs.filter(item => item !== tab); if (state.selected === projectTabKey(tab)) state.selected = '' },
  }
  projectDescriptorCache.set(id, descriptor)
  return descriptor
}
function setParking(element: Element | ComponentPublicInstance | null) { if (element instanceof HTMLElement) editorGroups.targets.set('parking', element) }
function ownerFocused(owner: string) { return editorGroups.active(selectedProjectId.value)?.owner === owner }

const liveState = useProjectLiveState()
const route = useRoute()
const router = useRouter()
const installation = useInstallationContext()
const mobile = useMobileChrome()
const mobileIntegrated = computed(() => !!mobile?.enabled.value && !!mobile.projectsTarget.value)
provide(HomeTreeCacheKey, createHomeTreeCache())
const projects = ref<ProjectRecord[]>([])
const registry = createConversationResources()
const resources = shallowRef<ConversationResource[]>([])
provide(WorkflowInputReferencesKey, {
  attach(item) {
    const editor = editorGroups.referenceTarget(selectedProjectId.value)
    if (!editor?.conversation?.editable || editor.projectId !== item.reference.projectId || !props.visible) return 'unavailable'
    editorGroups.activate(editor.id)
    const result = instances.get(editor.owner)?.appendInputReference(item) ?? 'unavailable'
    if (result === 'added' || result === 'duplicate') void nextTick(() => instances.get(editor.owner)?.focusConversation())
    return result
  },
})
const selected = shallowRef<ConversationResource>()
const { automation, syncAutomationRoute, showAutomation, openAutomationRun, identifyAutomation } = useAutomationNavigation({
  route, router, selected,
  openSession: session => publish(registry.session(session)),
  closeSidebar,
})
const workflowProjectId = computed(() => route.name === 'project-workflows' && typeof route.params.projectId === 'string' ? route.params.projectId : '')
const dashboardProject = computed(() => route.name === 'project-dashboard' ? projects.value.find(project => project.id === route.params.projectId) : undefined)
const selectedProjectId = computed(() => workflowProjectId.value || (dashboardProject.value?.id ?? automation.value?.projectId ?? selected.value?.projectId ?? ''))
const selectedProjectName = computed(() => projects.value.find(project => project.id === selectedProjectId.value)?.name ?? '')
const instances = new Map<string, InstanceType<typeof ProjectConversation>>()

// Project documents reuse the current workbench (including an unsent draft).
// Their deep links must not discard the conversation or each project's inspection.
const workflowQueries = new Map<string, Record<string, string>>()
const conversationQueries = new Map<string, typeof route.query>()
const projectWorkbenches = new Map<string, ConversationResource>()
let documentRoute = ''
const localSidebarOpen = ref(false)
const sidebarOpen = computed({
  get: () => mobileIntegrated.value ? mobile!.menuOpen.value : localSidebarOpen.value,
  set: value => { if (mobileIntegrated.value) mobile!.menuOpen.value = value; else localSidebarOpen.value = value },
})
const sessionSearchOpen = ref(false)
function openSessionSearch() { sessionSearchOpen.value = true }
function quickOpenSession(projectId: string, sessionId: string, automationId?: string) {
  sessionSearchOpen.value = false
  if (automationId) {
    automation.value = { projectId, id: automationId }
    openAutomationRun(sessionId)
  } else selectSession(projectId, sessionId)
}
function sessionSearchKeydown(event: KeyboardEvent) {
  if (!props.visible || !keyboardActive.value || !isSessionQuickOpenShortcut(event)) return
  event.preventDefault()
  // Reserve the chord without stealing focus from an existing modal workflow.
  if (document.querySelector('dialog[open], [aria-modal="true"]')) return
  openSessionSearch()
}
const creating = ref(false)
const name = ref('')
const saving = ref(false)
const loading = ref(true)
const error = ref('')
const workspaceElement = ref<HTMLElement>()
const sidebarElement = ref<HTMLElement>()
const sidebarTrigger = ref<HTMLButtonElement>()
const pinButton = ref<HTMLButtonElement>()
const closeButton = ref<HTMLButtonElement>()
const addProjectButton = ref<HTMLButtonElement>()
const desktop = ref(false)
const sidebarHidden = ref(false)
const preferredWidth = ref(DEFAULT_PROJECT_SIDEBAR.width)
const containerWidth = ref(800)
const sidebarPinned = computed(() => desktop.value && !sidebarHidden.value)
const sidebarVisible = computed(() => sidebarPinned.value || sidebarOpen.value)
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 200, 440))
const sidebarWidth = computed(() => clampSidebarWidth(preferredWidth.value, resizeBounds.value))
const storageKey = projectSidebarStorageKey(props.apiBase)
let sidebarObserver: ResizeObserver | undefined
const folderRevision = ref(0)
const notice = ref('')
const folderOperation = shallowRef<{ project: ProjectRecord; folder: FolderRecord; action: 'remove' | 'move' }>()
let catalog: ReturnType<typeof liveState.acquireCatalog> | undefined
let mutation: AbortController | undefined
function measureSidebar() {
  desktop.value = window.innerWidth > 700
  const width = workspaceElement.value?.getBoundingClientRect().width
  if (width) containerWidth.value = width
}
async function showProject(id: string) {
  if (!sidebarPinned.value) sidebarOpen.value = true
  await nextTick()
  const group = [...(sidebarElement.value?.querySelectorAll<HTMLElement>('[data-project-id]') ?? [])]
    .find(element => element.dataset.projectId === id)
  const toggle = group?.querySelector<HTMLButtonElement>('.project-toggle')
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    toggle.click()
    await nextTick()
  }
  group?.scrollIntoView({ block: 'nearest' })
  toggle?.focus({ preventScroll: true })
}
async function openSidebar() {
  sidebarOpen.value = true
  await nextTick()
  if (!sidebarOpen.value || !props.visible) return
  const current = [...(sidebarElement.value?.querySelectorAll<HTMLElement>('[aria-current="page"]') ?? [])]
    .find(element => element.getClientRects().length)
  const target = current ?? closeButton.value ?? pinButton.value
  target?.focus({ preventScroll: true })
}
function closeSidebar(restoreFocus = true) {
  if (!sidebarOpen.value) return
  sidebarOpen.value = false
  if (restoreFocus && props.visible) void nextTick(() => (mobileIntegrated.value ? mobile?.trigger.value : sidebarTrigger.value)?.focus({ preventScroll: true }))
}
function toggleSidebar() {
  if (sidebarOpen.value) closeSidebar()
  else void openSidebar()
}
async function togglePinned() {
  const hiding = sidebarPinned.value
  sidebarHidden.value = hiding
  sidebarOpen.value = false
  await nextTick()
  const target = hiding ? sidebarTrigger.value : pinButton.value
  target?.focus({ preventScroll: true })
}
function cancelCreateProject() {
  if (saving.value) return
  creating.value = false
  name.value = ''
  void nextTick(() => addProjectButton.value?.focus({ preventScroll: true }))
}
async function openCreateProject() {
  creating.value = true
  if (!sidebarPinned.value) sidebarOpen.value = true
  await nextTick()
  sidebarElement.value?.querySelector<HTMLInputElement>('.project-create input')?.focus()
}
function contentFocused(event: FocusEvent) {
  if (event.target instanceof Node && !sidebarTrigger.value?.contains(event.target)) closeSidebar(false)
}
function sidebarKeydown(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented || !props.visible || !sidebarOpen.value) return
  event.preventDefault()
  closeSidebar()
}
function manageFolder(project: ProjectRecord, folder: FolderRecord, action: 'remove' | 'move') {
  folderOperation.value = { project, folder, action }
}
function folderChanged(folder?: FolderRecord) {
  const operation = folderOperation.value
  if (!operation) return
  const target = projects.value.find(org => org.id === folder?.projectId)
  notice.value = folder ? t('{name} moved to {projectId}.', { name: operation.folder.name, projectId: target?.name ?? folder.projectId })
    : t('{name} removed from {name2}.', { name: operation.folder.name, name2: operation.project.name })
  notice.value += ' Files are unchanged; existing conversations remain in the original project.'
  folderOperation.value = undefined
  folderRevision.value++
  void showProject(operation.project.id)
}
function setConversation(key: string, component: Element | ComponentPublicInstance | null) {
  if (component) instances.set(key, component as InstanceType<typeof ProjectConversation>)
  else instances.delete(key)
}
function projectWorkbench(projectId: string): ConversationResource {
  return projectWorkbenches.get(projectId)
    ?? registry.resources.findLast(item => item.projectId === projectId) ?? registry.draft(projectId)
}
function publish(resource: ConversationResource) {
  projectWorkbenches.set(resource.projectId, resource)
  selected.value = resource
  resources.value = [...registry.resources]
  closeSidebar()
  if (route.name === 'chat') void nextTick(() => {
    const key = route.query.panel === 'knowledge' ? (typeof route.query.entry === 'string' ? knowledgeEntryTabKey(route.query.entry) : KNOWLEDGE_TAB_KEY) : route.query.panel === 'diagnosis' ? DIAGNOSIS_TAB_KEY : ''
    const descriptor = editorGroups.descriptors.get(`${resource.key}:${key}`)
    if (descriptor) editorGroups.open(descriptor)
  })
}
const consumedInspectionLinks = new Set<string>()
function syncRoute() {
  if (!props.visible || !['chat', 'project-dashboard', 'project-workflows', 'project-settings', 'agents'].includes(String(route.name))) return
  const projectId = typeof route.params.projectId === 'string' ? route.params.projectId : ''
  if (!projectId || !projects.value.some(org => org.id === projectId)) {
    selected.value = undefined
    automation.value = undefined
    if (projectId && !loading.value) error.value = t('This project is unavailable. Refresh the catalog or choose another project.')
    return
  }
  const nextDocumentRoute = `${String(route.name)}:${projectId}`
  const workflowQuery = workflowQueries.get(projectId)
  if (route.name === 'project-workflows' && documentRoute !== nextDocumentRoute
    && !Object.keys(route.query).length && (workflowQuery?.workflow || workflowQuery?.bot)) {
    void router.replace({ query: workflowQuery })
  }
  documentRoute = nextDocumentRoute
  if (route.name === 'project-dashboard') { selected.value = undefined; automation.value = undefined; closeSidebar(); return }
  const automationId = syncAutomationRoute(projectId)
  const sessionId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  let resource: ConversationResource
  if (sessionId) {
    resource = registry.session({ projectId, sessionId })
    const child = typeof route.query.child === 'string' ? route.query.child : undefined
    const link = JSON.stringify([projectId, sessionId, child])
    if (child && child !== sessionId && !consumedInspectionLinks.has(link)) { consumedInspectionLinks.add(link); openInspection(projectId, child) }
  }
  else if (automationId) { selected.value = undefined; closeSidebar(); return }
  else if (route.name !== 'chat') resource = projectWorkbench(projectId)
  else resource = selected.value?.projectId === projectId && !selected.value.sessionId ? selected.value : registry.draft(projectId)
  resource.knowledgeRequest = route.query.panel === 'knowledge'
    ? { entryId: typeof route.query.entry === 'string' ? route.query.entry : undefined } : undefined
  if (route.name === 'chat') {
    const { panel, entry, ...query } = route.query
    conversationQueries.set(resource.key, query)
  }
  publish(resource)
  const tab = route.name === 'project-workflows' ? 'workflows' : route.name === 'project-settings' || route.name === 'agents' ? 'settings' : undefined
  if (tab) {
    const state = projectDocuments.get(projectId)
    if (!state.tabs.includes(tab)) state.tabs = [...state.tabs, tab]
    state.selected = projectTabKey(tab)
    void nextTick(() => editorGroups.activate(projectEditorId(projectId, tab)))
  }
}
async function refresh() {
  await catalog?.refresh()
}
watch(() => props.apiBase, (base, _previous, onCleanup) => {
  const current = catalog = liveState.acquireCatalog(base)
  const stop = watch(() => [current.state.revision, current.state.loading, current.state.error], () => {
    loading.value = current.state.loading && !current.state.value
    error.value = current.state.error
    if (current.state.value) {
      const next = current.state.value
      for (const project of projects.value) {
        if (!next.some(item => item.id === project.id)) forgetProject(project.id)
      }
      projects.value = [...next]
      syncRoute()
    }
  }, { immediate: true })
  onCleanup(() => { stop(); current.release(); if (catalog === current) catalog = undefined })
}, { immediate: true })
async function createProject() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const controller = new AbortController()
  mutation = controller
  try {
    const project = await createProjectsClient(props.apiBase).save(name.value, undefined, controller.signal)
    if (controller.signal.aborted) return
    if (!projects.value.some(item => item.id === project.id)) projects.value.push(project)
    name.value = ''
    creating.value = false
    startDraft(project.id)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not create project. Retry.')
  } finally { saving.value = false }
}
function openDashboard(projectId: string) {
  void router.push({ name: 'project-dashboard', params: { projectId } })
}
async function composeFromDashboard(projectId: string, text: string) {
  await startDraft(projectId)
  await nextTick()
  if (selected.value?.projectId === projectId) instances.get(selected.value.key)?.appendDraft(text)
}
function startDraft(projectId: string, folder?: FolderRecord, remote = false) {
  automation.value = undefined
  const resource = registry.draft(projectId, folder, remote)
  publish(resource)
  return router.push(projectChatLocation(resource))
}
const keyboardActive = ref(true)
const newConversationShortcut = createNewConversationShortcut({
  context() {
    if (!keyboardActive.value || !props.visible || creating.value || hasVisibleNewConversationOverlay(document.querySelectorAll('[aria-modal="true"], dialog[open], [role="menu"], [role="dialog"]'))
      || !['chat', 'project-dashboard', 'project-workflows', 'project-settings', 'agents'].includes(String(route.name))) return
    const projectId = selectedProjectId.value || (typeof route.params.projectId === 'string' ? route.params.projectId : '')
    if (!projects.value.some(project => project.id === projectId)) return
    // Ctrl+N matches the sidebar's explicit Start from scratch action, never inherits a workdir.
    return { projectId, sessionId: '' }
  },
  async resolveFolder() { return undefined },
  start(context, folder) { startDraft(context.projectId, folder) },
  failed(cause) {
    error.value = cause instanceof Error ? cause.message : t('Could not resolve the conversation folder. Retry.')
    sidebarOpen.value = true
  },
})
// Synchronous cancellation also covers switching away and back during a pending read.
watch(() => [route.fullPath, selected.value?.key, selected.value?.sessionId, automation.value?.id,
  props.apiBase, props.visible, keyboardActive.value,
  projects.value.map(project => project.id).join(',')], () => newConversationShortcut.cancel(), { flush: 'sync' })
function openInspection(projectId: string, sessionId: string) {
  const existed = registry.resources.some(item => item.projectId === projectId && item.sessionId === sessionId)
  const resource = registry.session({ projectId, sessionId })
  if (!existed) resource.inspection = true
  resources.value = [...registry.resources]
  void nextTick(() => { const id = `${resource.key}:`; if (editorGroups.descriptors.has(id)) editorGroups.move(id, 'right') })
}
function navigate(projectId: string, sessionId: string, child?: string) {
  automation.value = undefined
  if (!sessionId) { startDraft(projectId); return }
  const resource = registry.session({ projectId, sessionId })
  publish(resource)
  if (child && child !== sessionId) openInspection(projectId, child)
  void router.push({ ...projectChatLocation({ projectId, sessionId }), query: child ? { child } : {} })
}
function selectSession(projectId: string, sessionId: string) {
  const current = selected.value
  if (current?.projectId === projectId && current.sessionId !== sessionId) {
    const instance = instances.get(current.key)
    if (instance) { instance.requestSession(sessionId); closeSidebar(); return }
  }
  navigate(projectId, sessionId)
}
function openKnowledge(projectId: string) {

  automation.value = undefined
  const resource = projectWorkbench(projectId)
  publish(resource)
  void router.push({ ...projectChatLocation(resource), query: { ...conversationQueries.get(resource.key), panel: 'knowledge' } })
}
// Project document tabs restore their own route context. Track the route, not
// cached components, which also see other documents and Projects while hidden.
watch(() => route.fullPath, () => {
  const projectId = typeof route.params.projectId === 'string' ? route.params.projectId : ''
  if (route.name === 'project-workflows' && projectId) {
    const query: Record<string, string> = {}
    if (typeof route.query.bot === 'string') query.bot = route.query.bot
    if (typeof route.query.workflow === 'string') query.workflow = route.query.workflow
    if (typeof route.query.run === 'string') query.run = route.query.run
    workflowQueries.set(projectId, query)
  }
}, { flush: 'post', immediate: true })
const settingsSections = new Map<string, string>()
watch(() => [route.name, route.params.projectId, route.params.section] as const, ([name, projectId, section]) => {
  if (name === 'project-settings' && typeof projectId === 'string') {
    settingsSections.set(projectId, typeof section === 'string' && section ? section : 'general')
  }
}, { immediate: true })
function projectNavigation(resource: ConversationResource, tab?: ProjectTab, documentKey?: string) {
  if (!props.visible || selected.value?.key !== resource.key || route.params.projectId !== resource.projectId) return
  if (tab === 'workflows') {
    if (route.name !== 'project-workflows') void router.push({ name: 'project-workflows',
      params: { projectId: resource.projectId }, query: workflowQueries.get(resource.projectId) ?? {} })
  } else if (tab === 'settings') {
    if (route.name !== 'project-settings') {
      void router.push({ name: 'project-settings',
        params: { projectId: resource.projectId, section: settingsSections.get(resource.projectId) ?? 'general' } })
    }
  } else if (route.name === 'project-settings' || route.name === 'agents' || route.name === 'project-workflows') {
    const query = { ...conversationQueries.get(resource.key) }
    if (documentKey === DIAGNOSIS_TAB_KEY) query.panel = 'diagnosis'
    else delete query.diagnosis
    void router.push({ ...projectChatLocation(resource), query })
  }
}
function prepared(key: string, sessionId: string) {
  const resource = registry.prepared(key, sessionId)
  resources.value = [...registry.resources]
  // A delayed upload/prepare in A must not navigate away from B.
  if (selected.value?.key === key && props.visible && route.name === 'chat') {
    void router.replace({ ...projectChatLocation(resource), query: { ...route.query, child: resource.childSessionId } })
  }
}
function deleted(projectId: string, sessionId: string) {
  if (projectWorkbenches.get(projectId)?.sessionId === sessionId) projectWorkbenches.delete(projectId)
  registry.removeSession({ projectId, sessionId })
  resources.value = [...registry.resources]
  if (selected.value?.projectId === projectId && selected.value.sessionId === sessionId) startDraft(projectId)
}
function forgetProject(projectId: string) {
  for (const [id, descriptor] of editorGroups.descriptors) if (descriptor.projectId === projectId) editorGroups.unregister(id)
  editorGroups.projects.delete(projectId)
  for (const resource of registry.resources) if (resource.projectId === projectId) conversationQueries.delete(resource.key)
  projectDocuments.projects.delete(projectId)
  for (const id of projectDescriptorCache.keys()) if (id.startsWith(`${projectId}:project:`)) projectDescriptorCache.delete(id)
  registry.removeProject(projectId)
  projectWorkbenches.delete(projectId)
  workflowQueries.delete(projectId)
  resources.value = [...registry.resources]
  if (folderOperation.value?.project.id === projectId) folderOperation.value = undefined
  if (selected.value?.projectId === projectId) selected.value = undefined
  if (automation.value?.projectId === projectId) automation.value = undefined
  if (route.params.projectId === projectId) void router.replace({ name: 'projects' })
}
function projectDeleted(projectId: string) {
  forgetProject(projectId)
  projects.value = projects.value.filter(project => project.id !== projectId)
  notice.value = t('Project deleted. Working folders and their files were kept.')
  void refresh()
}
function onProjectDeleted(event: Event) {
  const id = (event as CustomEvent<{ projectId?: string }>).detail?.projectId
  if (id) projectDeleted(id)
}
watch(() => [route.fullPath, props.visible], syncRoute)
watch(() => route.fullPath, () => { sessionSearchOpen.value = false; closeSidebar(false) })
watch(() => props.visible, visible => { if (!visible) { sessionSearchOpen.value = false; closeSidebar(false) } })
watch(desktop, () => {
  const hadFocus = sidebarElement.value?.contains(document.activeElement)
  closeSidebar(false)
  if (hadFocus && !sidebarPinned.value) void nextTick(() => sidebarTrigger.value?.focus({ preventScroll: true }))
})
watch([preferredWidth, sidebarHidden], ([width, collapsed]) => {
  try { window.localStorage.setItem(storageKey, JSON.stringify({ width, collapsed })) }
  catch { console.warn('[projects] Could not save sidebar preferences; layout will reset after reload.') }
})
const onCatalogChanged = () => { void refresh() }
onMounted(() => {
  try {
    const preferences = restoreProjectSidebarPreferences(window.localStorage, props.apiBase)
    preferredWidth.value = preferences.width
    sidebarHidden.value = preferences.collapsed
  } catch { console.warn('[projects] Could not restore sidebar preferences; using the default layout.') }
  sidebarObserver = new ResizeObserver(measureSidebar)
  if (workspaceElement.value) sidebarObserver.observe(workspaceElement.value)
  measureSidebar()
  window.addEventListener('resize', measureSidebar)
  window.addEventListener('shadow:projects-changed', onCatalogChanged)
  window.addEventListener('shadow:project-deleted', onProjectDeleted)
  window.addEventListener('keydown', sidebarKeydown)
  window.addEventListener('keydown', sessionSearchKeydown)
  window.addEventListener('keydown', newConversationShortcut.keydown)
})
onActivated(() => { keyboardActive.value = true })
onDeactivated(() => { sessionSearchOpen.value = false; keyboardActive.value = false; newConversationShortcut.cancel(); closeSidebar(false) })
onUnmounted(() => {
  keyboardActive.value = false
  newConversationShortcut.cancel()
  window.removeEventListener('keydown', newConversationShortcut.keydown)
  mutation?.abort(); sidebarObserver?.disconnect()
  window.removeEventListener('resize', measureSidebar)
  window.removeEventListener('shadow:projects-changed', onCatalogChanged)
  window.removeEventListener('shadow:project-deleted', onProjectDeleted)
  window.removeEventListener('keydown', sidebarKeydown)
  window.removeEventListener('keydown', sessionSearchKeydown)
})
</script>

<style scoped>
.session-search-trigger { display: flex; align-items: center; gap: 8px; margin: 0 8px 8px; padding: 6px 8px; min-height: 36px; border: 1px solid var(--c-border); background: var(--c-bg-input); color: var(--c-text-secondary); font: inherit; font-size: 13px; text-align: left; cursor: pointer; }
.session-search-trigger:hover { background: var(--c-bg-muted); color: var(--c-text); }
.session-search-trigger:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.session-search-trigger kbd { margin-left: auto; padding: 1px 4px; border: 1px solid var(--c-border); border-radius: var(--radius-sm); background: var(--c-bg-soft); color: var(--c-text-secondary); font-family: var(--font-mono, ui-monospace, monospace); font-size: 11px; font-weight: 400; line-height: 16px; white-space: nowrap; }
@media (max-width: 700px), (pointer: coarse) { .session-search-trigger { min-height: 44px; } }
.projects-workspace { display: flex; position: relative; flex: 1; min-width: 0; min-height: 0; height: 100%; }
.projects-sidebar { position: relative; display: flex; flex-direction: column; flex: 0 0 var(--projects-width, 270px); width: var(--projects-width, 270px); min-width: 0; min-height: 0; border-right: 1px solid var(--c-border); background: var(--c-bg-card); }
.projects-sidebar.in-mobile-menu { flex: 1; width: 100%; border: 0; }
.projects-heading { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; min-height: 48px; gap: 8px; padding: 8px 12px; }
.projects-heading h1 { margin: 0; min-width: 0; font-size: 15px; line-height: 20px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.projects-heading-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; }
.project-add { display: grid; place-items: center; border: 0; width: var(--sidebar-action-size); height: var(--sidebar-action-size); padding: 0; color: var(--c-text); background: transparent; }
.project-add:hover { background: var(--c-bg-muted); }
.project-groups { display: flex; flex-direction: column; gap: var(--sidebar-group-gap); flex: 1; min-height: 0; padding-bottom: var(--sidebar-section-gap); overflow-y: auto; overscroll-behavior: contain; }
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
.projects-toolbar { display: flex; align-items: center; flex: 0 0 44px; min-width: 0; padding-inline: 8px; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); }
.projects-toggle { display: flex; align-items: center; gap: 8px; min-width: 0; max-width: 100%; min-height: 36px; padding: 4px 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; }
.projects-toggle:hover, .projects-toggle[aria-expanded="true"] { background: var(--c-bg-muted); }
.projects-toggle > span:not(.projects-current-name) { flex-shrink: 0; }
.projects-current-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.projects-sidebar.is-floating { position: absolute; inset: 44px auto 0 0; z-index: 50; width: min(var(--projects-width), calc(100% - 40px)); box-shadow: 8px 0 24px var(--c-shadow-soft); }
.projects-backdrop { position: absolute; inset: 44px 0 0; z-index: 49; padding: 0; border: 0; background: var(--c-shadow-softer); }
@media (max-width: 700px), (pointer: coarse) { .projects-toggle { min-height: 44px; } }
@media (max-width: 1000px) { .project-secondary-editor { position: absolute; right: 0; top: 0; bottom: 0; z-index: 20; max-width: calc(100% - 32px); box-shadow: -8px 0 24px var(--c-shadow-soft); } }
.project-document-host { display: flex; flex: 1; min-height: 0; min-width: 0; }
</style>
