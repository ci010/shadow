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
          <button class="project-add" :aria-label="t('Add project')" :aria-expanded="creating" @click="creating = !creating"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
          <button v-if="!sidebarPinned && !mobileIntegrated" ref="closeButton" class="project-add" :aria-label="t('Close projects')" @click="closeSidebar()"><span class="i-lucide-x w-4 h-4" aria-hidden="true" /></button>
        </div>
      </header>
      <form v-if="creating" class="project-create" @submit.prevent="createProject">
        <label>{{ t('Project name') }}<input v-model="name" required autocomplete="off" :disabled="saving" /></label>
        <button class="btn btn-sm" :disabled="saving || !name.trim()">{{ saving ? t('Creating...') : t('Create project') }}</button>
      </form>
      <p v-if="loading" class="project-note" role="status">{{ t('Loading projects...') }}</p>
      <div v-if="error" class="project-note project-error" role="alert"><p>{{ error }}</p><button class="btn btn-sm" @click="refresh">{{ t('Retry catalog') }}</button></div>
      <div id="project-groups" class="project-groups">
        <ProjectGroup v-for="project in projects" :key="project.id" :api-base="apiBase" :project="project"
          :data-project-id="project.id" :folder-revision="folderRevision"
          :navigation-key="`${route.fullPath}:${visible}`"
          :selected-project-id="selectedProjectId" :selected-session-id="selected?.sessionId ?? ''" :selected-automation-id="automation?.id"
          :dashboard-selected="selected ? dashboardVisibility.get(selected.key) !== false : false"
          :draft-folder-id="selected?.folder?.id" :remote-folders="(installation.mode === 'main' || installation.mainWorkspace === true)"
          @select="selectSession(project.id, $event)" @draft="(folder, remote) => startDraft(project.id, folder, remote)"
          @knowledge="openKnowledge(project.id)"
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
      <AutomationDetail :enabled="!!automation"
        :api-base="automation ? projectBase(apiBase, automation.projectId) : apiBase" :automation-id="automation?.id ?? ''" :active="visible"
        :selected-session-id="selected?.sessionId"
        @open="openAutomationRun">
      <section v-if="!selected && !automation" class="project-empty">
        <h1>{{ t('Where would you like to work?') }}</h1>
        <p>{{ t('Choose a folder or start a chat in a project. Each project keeps its own Home and model defaults.') }}</p>
        <button v-for="project in projects" :key="project.id" class="btn" @click="startDraft(project.id)">{{ t('Start in') }} {{ project.name }}</button>
        <button v-if="!projects.length && !loading && !error" class="btn" @click="openCreateProject">{{ t('Create a project') }}</button>
      </section>
      <ProjectConversation v-for="resource in resources" :key="resource.key"
        :ref="component => setConversation(resource.key, component)"
        v-show="selected?.key === resource.key" :visible="visible && selected?.key === resource.key"
        :api-base="projectBase(apiBase, resource.projectId)" :project-id="resource.projectId"
        :project-name="projects.find(item => item.id === resource.projectId)?.name ?? resource.projectId"
        :session-id="resource.sessionId" :initial-folder="resource.folder" :open-remote="resource.openRemote"
        :automation-run="!!automation && selected?.key === resource.key"
        :child-session-id="resource.childSessionId"
        :knowledge-request="resource.knowledgeRequest" @knowledge-navigation="(active, entryId) => knowledgeNavigation(resource, active, entryId)"
        @project-navigation="tab => projectNavigation(resource, tab)"
        @dashboard-visible="dashboardVisibility.set(resource.key, $event)"
        @navigate="(id, child) => navigate(resource.projectId, id, child)" @prepared="prepared(resource.key, $event)" @deleted="deleted(resource.projectId, $event)" />
      </AutomationDetail>
    </div>
    <FolderOwnershipDialog v-if="folderOperation" :key="`${folderOperation.project.id}:${folderOperation.folder.id}:${folderOperation.action}`"
      :api-base="apiBase" :project="folderOperation.project" :projects="projects"
      :folder="folderOperation.folder" :action="folderOperation.action" @close="folderOperation = undefined"
      @refresh="folderOperation = undefined; folderRevision++" @changed="folderChanged" />
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, provide, reactive, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
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
import { type FolderRecord } from '../folders-client.ts'
import { createNewConversationShortcut, hasVisibleNewConversationOverlay } from '../new-conversation-shortcut.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { DEFAULT_PROJECT_SIDEBAR, projectSidebarStorageKey, restoreProjectSidebarPreferences } from '../project-sidebar.ts'
import { createHomeTreeCache, HomeTreeCacheKey } from '../home-tree-cache.ts'
import { useAutomationNavigation } from '../composables/useAutomationNavigation.ts'
import { useMobileChrome } from '../composables/useMobileChrome.ts'
import { useProjectLiveState } from '../composables/useProjectLiveState.ts'
import type { ProjectTab } from '../file-workbench.ts'

defineOptions({ name: 'ProjectsWorkspace' })
const props = withDefaults(defineProps<{ apiBase: string; visible?: boolean }>(), { visible: true })
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
const selected = shallowRef<ConversationResource>()
const dashboardVisibility = reactive(new Map<string, boolean>())
const { automation, syncAutomationRoute, showAutomation, openAutomationRun, identifyAutomation } = useAutomationNavigation({
  route, router, selected,
  openSession: session => publish(registry.session(session)),
  closeSidebar,
})
const selectedProjectId = computed(() => automation.value?.projectId ?? selected.value?.projectId ?? '')
const selectedProjectName = computed(() => projects.value.find(project => project.id === selectedProjectId.value)?.name ?? '')
const instances = new Map<string, InstanceType<typeof ProjectConversation>>()
const localSidebarOpen = ref(false)
const sidebarOpen = computed({
  get: () => mobileIntegrated.value ? mobile!.menuOpen.value : localSidebarOpen.value,
  set: value => { if (mobileIntegrated.value) mobile!.menuOpen.value = value; else localSidebarOpen.value = value },
})
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
function publish(resource: ConversationResource) {
  selected.value = resource
  resources.value = [...registry.resources]
  closeSidebar()
}
function syncRoute() {
  if (!props.visible || !['chat', 'project-settings', 'agents'].includes(String(route.name))) return
  const projectId = typeof route.params.projectId === 'string' ? route.params.projectId : ''
  if (!projectId || !projects.value.some(org => org.id === projectId)) {
    selected.value = undefined
    automation.value = undefined
    if (projectId && !loading.value) error.value = t('This project is unavailable. Refresh the catalog or choose another project.')
    return
  }
  const automationId = syncAutomationRoute(projectId)
  const sessionId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  let resource: ConversationResource
  if (sessionId) {
    resource = registry.session({ projectId, sessionId })
    resource.childSessionId = typeof route.query.child === 'string' ? route.query.child : undefined
  }
  else if (automationId) { selected.value = undefined; closeSidebar(); return }
  else if (route.name !== 'chat') resource = selected.value?.projectId === projectId ? selected.value
    : registry.resources.findLast(item => item.projectId === projectId) ?? registry.draft(projectId)
  else resource = selected.value?.projectId === projectId && !selected.value.sessionId ? selected.value : registry.draft(projectId)
  resource.knowledgeRequest = route.query.panel === 'knowledge'
    ? { entryId: typeof route.query.entry === 'string' ? route.query.entry : undefined } : undefined
  publish(resource)
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
function startDraft(projectId: string, folder?: FolderRecord, remote = false) {
  automation.value = undefined
  const resource = registry.draft(projectId, folder, remote)
  publish(resource)
  void router.push(projectChatLocation(resource))
}
const keyboardActive = ref(true)
const newConversationShortcut = createNewConversationShortcut({
  context() {
    if (!keyboardActive.value || !props.visible || creating.value || hasVisibleNewConversationOverlay(document.querySelectorAll('[aria-modal="true"], dialog[open], [role="menu"], [role="dialog"]'))
      || !['chat', 'project-settings', 'agents'].includes(String(route.name))) return
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
function navigate(projectId: string, sessionId: string, child?: string) {
  automation.value = undefined
  if (!sessionId) { startDraft(projectId); return }
  const resource = registry.session({ projectId, sessionId })
  resource.childSessionId = child
  publish(resource)
  void router.push({ ...projectChatLocation({ projectId, sessionId }), query: child ? { child } : {} })
}
function selectSession(projectId: string, sessionId: string) {
  if (!sessionId.startsWith('observed-group:') && !selected.value?.sessionId.startsWith('observed-group:') && selected.value?.projectId === projectId) {
    const instance = instances.get(selected.value.key)
    if (instance) { instance.requestSession(sessionId); closeSidebar(); return }
  }
  navigate(projectId, sessionId)
}
function openKnowledge(projectId: string) {

  automation.value = undefined
  const resource = selected.value?.projectId === projectId ? selected.value
    : registry.resources.findLast(item => item.projectId === projectId) ?? registry.draft(projectId)
  publish(resource)
  void router.push({ ...projectChatLocation(resource), query: { panel: 'knowledge' } })
}
function knowledgeNavigation(resource: ConversationResource, active: boolean, entryId?: string) {
  if (!props.visible || selected.value?.key !== resource.key || !['chat', 'project-settings', 'agents'].includes(String(route.name))
    || route.params.projectId !== resource.projectId || (route.name === 'chat' && (route.params.sessionId || '') !== resource.sessionId)) return
  const query = { ...route.query }
  if (active) {
    query.panel = 'knowledge'
    delete query.diagnosis
    if (entryId) query.entry = entryId
    else delete query.entry
  } else {
    if (query.panel !== 'knowledge') return
    delete query.panel
    delete query.entry
  }
  if (route.name !== 'chat' && active) void router.push({ ...projectChatLocation(resource), query })
  else if (query.panel !== route.query.panel || query.entry !== route.query.entry) void router.push({ query })
}
function projectNavigation(resource: ConversationResource, tab?: ProjectTab) {
  if (!props.visible || selected.value?.key !== resource.key || route.params.projectId !== resource.projectId) return
  if (tab) {
    if (route.name !== 'project-settings') {
      void router.push({ name: 'project-settings',
        params: { projectId: resource.projectId, section: 'general' } })
    }
  } else if (route.name === 'project-settings' || route.name === 'agents') {
    void router.push(projectChatLocation(resource))
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
  registry.removeSession({ projectId, sessionId })
  resources.value = [...registry.resources]
  if (selected.value?.projectId === projectId && selected.value.sessionId === sessionId) startDraft(projectId)
}
function forgetProject(projectId: string) {
  for (const resource of registry.resources) {
    if (resource.projectId === projectId) dashboardVisibility.delete(resource.key)
  }
  registry.removeProject(projectId)
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
watch(() => route.fullPath, () => { closeSidebar(false) })
watch(() => props.visible, visible => { if (!visible) closeSidebar(false) })
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
  window.addEventListener('keydown', newConversationShortcut.keydown)
})
onActivated(() => { keyboardActive.value = true })
onDeactivated(() => { keyboardActive.value = false; newConversationShortcut.cancel(); closeSidebar(false) })
onUnmounted(() => {
  keyboardActive.value = false
  newConversationShortcut.cancel()
  window.removeEventListener('keydown', newConversationShortcut.keydown)
  mutation?.abort(); sidebarObserver?.disconnect()
  window.removeEventListener('resize', measureSidebar)
  window.removeEventListener('shadow:projects-changed', onCatalogChanged)
  window.removeEventListener('shadow:project-deleted', onProjectDeleted)
  window.removeEventListener('keydown', sidebarKeydown)
})
</script>

<style scoped>
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
</style>
