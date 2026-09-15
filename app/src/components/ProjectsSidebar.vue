<template>
  <aside :id="grouped ? domId('sessions-sidebar') : 'sessions-sidebar'" ref="sidebar" class="projects-sidebar sessions-sidebar" :class="{ 'is-rail': isRail, 'is-grouped': grouped }" :aria-label="organizationName || 'Projects'" :style="{ '--projects-width': `${isRail ? 64 : sidebarWidth}px` }">
    <SidebarResizer v-if="!grouped && desktop && resizeActive && !isRail" class="projects-resizer" :model-value="sidebarWidth" :bounds="resizeBounds"
      label="Resize projects" controls="sessions-sidebar" @update:model-value="preferredWidth = $event" />
    <header class="projects-header">
      <h2 v-if="!isRail"><button v-if="grouped" class="organization-toggle" :aria-expanded="groupExpanded" :aria-controls="domId('projects-navigation')" @click="groupExpanded = !groupExpanded"><span class="i-lucide-chevron-right w-3.5 h-3.5" :class="{ 'org-expanded': groupExpanded }" aria-hidden="true" />{{ organizationName }}</button><template v-else>Projects</template></h2>
      <div class="projects-header-actions">
        <slot name="organization-actions" />
        <HoverInfo v-if="!grouped && desktop" :text="isRail ? 'Expand projects' : 'Collapse projects'"><template #default="{ triggerProps }">
          <button class="project-add projects-rail-toggle" v-bind="triggerProps" :aria-label="isRail ? 'Expand projects' : 'Collapse projects'" :aria-expanded="!isRail" aria-controls="projects-navigation" @click="railCollapsed = !railCollapsed">
            <span :class="isRail ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="w-4 h-4" aria-hidden="true" />
          </button>
        </template></HoverInfo>
        <HoverInfo text="Add project"><template #default="{ triggerProps }">
          <button ref="menuButton" class="project-add" v-bind="triggerProps" :aria-label="organizationName ? `New work in ${organizationName}` : 'Add project'" aria-haspopup="menu" :aria-expanded="menuOpen" :aria-controls="domId('project-actions')" @click="toggleMenu" @keydown.down.prevent="openMenu"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
        </template></HoverInfo>
      </div>
    </header>
    <div v-show="!grouped || groupExpanded" :id="domId('projects-navigation')" class="projects-scroll" :aria-busy="loading || sessionsLoading">
      <p v-if="loading" class="sidebar-note" :class="{ 'rail-note': isRail }" role="status"><span v-if="isRail" class="i-lucide-loader-circle w-4 h-4" aria-hidden="true" /><span :class="{ 'rail-visually-hidden': isRail }">Loading projects…</span></p>
      <div v-if="error && !isRail" class="sidebar-error" role="alert">
        <p>{{ error }}</p>
        <button class="text-action" @click="loadProjects">Retry projects</button>
      </div>
      <HoverInfo v-if="error && isRail" :text="error"><template #default="{ triggerProps }"><button class="rail-status-button" v-bind="triggerProps" aria-label="Projects unavailable. Retry projects" @click="loadProjects"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
      <p v-if="!loading && !error && !projects.length && !isRail" class="sidebar-note">Open a folder to keep its conversations together.</p>
      <section v-for="group in groups.projects" :key="group.project.id" class="project-group">
        <TreeRow class="project-folder-row" :selected="selectedProjectId === group.project.id"
          :class="{ working: !!projectWorkingStage(group.sessions) }" :icon-only="isRail"
          :label="group.project.name" :title="group.project.kind === 'remote' ? `${group.project.workdir.nodeId}: ${group.project.path}` : group.project.path" :expanded="expandedProjects.has(group.project.id)" separate-toggle
          button-class="project-folder" toggle-class="project-toggle"
          :toggle-label="`${expandedProjects.has(group.project.id) ? 'Collapse' : 'Expand'} project ${group.project.name}`"
          @toggle="toggleProject(group.project.id)" @select="selectProject(group.project.id)"
          @contextmenu.prevent="grouped && openProjectActions(group.project, $event)">
          <template #icon><span v-if="isRail" class="project-initial">{{ railInitial(group.project.name) }}</span><span v-else :class="group.project.kind === 'remote' ? 'i-lucide-monitor' : expandedProjects.has(group.project.id) ? 'i-lucide-folder-open' : 'i-lucide-folder'" /></template>
          <template #meta><SessionActivity v-if="projectWorkingStage(group.sessions)" :stage="projectWorkingStage(group.sessions)" compact :title="undefined" /></template>
          <template #actions>
            <HoverInfo :text="`New conversation in ${group.project.name}`"><template #default="{ triggerProps }"><button class="project-add folder-add" v-bind="triggerProps" :aria-label="`New conversation in ${group.project.name}`" @click="startProjectDraft(group.project)"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
            <button v-if="grouped" class="project-add folder-add folder-actions" :aria-label="`Folder actions for ${group.project.name}`"
              aria-haspopup="menu" :aria-expanded="menuOpen && menuProject?.id === group.project.id" :aria-controls="domId('project-actions')"
              @click="openProjectActions(group.project, $event)" @keydown.down.prevent="openProjectActions(group.project, $event)"><span class="i-lucide-ellipsis w-4 h-4" aria-hidden="true" /></button>
          </template>
          <template #info="{ close }">
            <div class="project-info">
              <strong class="project-info-title">{{ group.project.name }}</strong>
              <p v-if="group.project.kind === 'remote'">Remote device: {{ group.project.workdir.nodeId }}</p>
              <p class="project-info-path">{{ group.project.path }}</p>
              <p>{{ group.sessions.length }} {{ group.sessions.length === 1 ? 'conversation' : 'conversations' }}</p>
              <button class="project-info-new" @click="startProjectDraft(group.project); close()">New conversation</button>
              <ProjectSessionList v-if="group.sessions.length" class="project-info-conversations" :sessions="group.sessions" :active-session-id="activeSessionId"
                :collapsed="collapsed" :stages="stages" :show-info="false" @select="selectConversation($event); close()" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
            </div>
          </template>
        </TreeRow>
        <div v-if="!isRail && expandedProjects.has(group.project.id)" class="project-conversations">
          <p v-if="!group.sessions.length" class="empty-project">No conversations yet</p>
          <ProjectSessionList :sessions="group.sessions" :depth="1" :active-session-id="activeSessionId" :collapsed="collapsed" :stages="stages" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
        </div>
      </section>
      <section class="legacy-chats" :aria-labelledby="domId('legacy-chats-heading')">
        <h3 :id="domId('legacy-chats-heading')" :class="{ 'rail-visually-hidden': isRail }">Chats</h3>
        <p v-if="sessionsLoading" class="sidebar-note" :class="{ 'rail-note': isRail, 'rail-visually-hidden': sessions.length > 0 }" role="status"><span v-if="isRail" class="i-lucide-loader-circle w-4 h-4" aria-hidden="true" /><span :class="{ 'rail-visually-hidden': isRail }">Loading conversations…</span></p>
        <div v-if="sessionsError && !isRail" class="sidebar-error" role="alert"><p>{{ sessionsError }}</p><button class="text-action" @click="$emit('reload')">Retry conversations</button></div>
        <HoverInfo v-if="sessionsError && isRail" :text="sessionsError"><template #default="{ triggerProps }"><button class="rail-status-button" v-bind="triggerProps" aria-label="Conversations unavailable. Retry conversations" @click="$emit('reload')"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
        <p v-if="(!sessionsLoading || sessions.length > 0) && !groups.chats.length && !isRail" class="sidebar-note">No unassociated conversations.</p>
        <ProjectSessionList :sessions="groups.chats" :rail="isRail" :active-session-id="activeSessionId" :collapsed="collapsed" :stages="stages" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
      </section>
      <section class="self-reflection-section" aria-label="Self reflection">
        <HoverInfo :text="`Self reflection · ${groups.reflections.length} conversations`"><template #default="{ triggerProps }">
          <button type="button" class="self-reflection-toggle" :class="{ active: reflectionActive, working: !!reflectionWorkingStage }"
            v-bind="triggerProps" :aria-label="`Self reflection, ${groups.reflections.length} conversations${reflectionActive ? ', active conversation' : ''}`"
            :aria-expanded="reflectionsExpanded" :aria-controls="domId('self-reflection-conversations')" @click="reflectionsExpanded = !reflectionsExpanded">
            <span class="self-reflection-caret" aria-hidden="true"><span class="i-lucide-chevron-right" :class="{ open: reflectionsExpanded }" /></span>
            <span class="self-reflection-icon i-lucide-brain" aria-hidden="true" />
            <span class="self-reflection-label">Self reflection</span>
            <span class="self-reflection-count" aria-hidden="true">{{ groups.reflections.length }}</span>
            <SessionActivity v-if="reflectionWorkingStage" :stage="reflectionWorkingStage" compact :title="undefined" />
          </button>
        </template></HoverInfo>
        <div v-if="reflectionsExpanded" :id="domId('self-reflection-conversations')" class="self-reflection-conversations">
          <p v-if="!groups.reflections.length && !isRail" class="sidebar-note">No self reflections yet.</p>
          <ProjectSessionList :sessions="groups.reflections" :rail="isRail" :active-session-id="activeSessionId" :collapsed="collapsed"
            :stages="stages" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
        </div>
      </section>
      <div v-if="cloneStatus.state === 'unknown' || cloneStatus.state === 'failed'" class="sidebar-error" role="alert">
        <template v-if="!isRail"><p>{{ cloneStatus.error }}</p><button class="text-action" @click="dialogMode = 'clone'">Review clone</button></template>
        <HoverInfo v-else :text="cloneStatus.error"><template #default="{ triggerProps }"><button class="rail-status-button" v-bind="triggerProps" aria-label="Review clone error" @click="dialogMode = 'clone'"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
      </div>
    </div>
    <ProjectDialog :mode="dialogMode" :client="client" @close="dialogMode = null" @registered="projectRegistered" @status="cloneStatus = $event" />
    <Teleport to="body">
      <div v-if="menuOpen" class="project-menu-backdrop" @click.self="closeMenu(false)" @keydown.esc.prevent.stop="closeMenu(true)">
        <div :id="domId('project-actions')" ref="menu" class="project-menu" role="menu" :aria-label="menuProject ? `Folder actions for ${menuProject.name}` : 'Add project'" :style="menuPosition" @keydown="menuKeydown">
          <button v-for="action in menuActions" :key="action.id" role="menuitem" @click="runAction(action.id)">{{ action.label }}</button>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, useId, watch } from 'vue'
import ProjectDialog from './ProjectDialog.vue'
import ProjectSessionList from './ProjectSessionList.vue'
import TreeRow from './TreeRow.vue'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import SessionActivity from './SessionActivity.vue'
import { railInitial } from '../project-rail.ts'
import { isWorkingStage } from '../session-activity.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { createProjectsClient, type CloneView, type ProjectRecord } from '../projects-client.ts'
import { groupProjectSessions, PROJECT_ACTIONS, type SidebarSession } from '../projects-sidebar.ts'

const props = defineProps<{
  apiBase: string
  grouped?: boolean
  organizationName?: string
  projectRevision?: number
  sessions: SidebarSession[]
  activeSessionId: string
  draftProjectId?: string
  remoteFolders?: boolean
  collapsed: ReadonlySet<string>
  stages: Record<string, string>
  sessionsLoading: boolean
  sessionsError: string
}>()
const emit = defineEmits<{
  select: [id: string]
  delete: [id: string]
  toggle: [id: string]
  reload: []
  scratch: []
  remote: []
  draft: [project: ProjectRecord]
  manage: [project: ProjectRecord, action: 'remove' | 'move']
}>()
const client = createProjectsClient(props.apiBase)
const groupExpanded = ref(true)
const componentId = useId()
const domId = (id: string) => props.grouped ? `${componentId}-${id}` : id
const projectActions = computed(() => PROJECT_ACTIONS.filter(action => action.id !== 'remote' || props.remoteFolders))
const projects = ref<ProjectRecord[]>([])
const groups = computed(() => groupProjectSessions(projects.value, props.sessions))
const reflectionsExpanded = ref(false)
const reflectionActive = computed(() => groups.value.reflections.some(session => session.sessionId === props.activeSessionId))
const reflectionWorkingStage = computed(() => projectWorkingStage(groups.value.reflections))
const expandedProjects = reactive(new Set<string>())
const selectedProjectId = ref('')
const loading = ref(false)
const error = ref('')
const cloneStatus = ref<CloneView>({ state: 'idle' })
const dialogMode = ref<'open' | 'clone' | null>(null)
const menuOpen = ref(false)
const menuProject = ref<ProjectRecord>()
const menuActions = computed(() => menuProject.value
  ? [{ id: 'move' as const, label: 'Move to organization...' }, { id: 'remove' as const, label: 'Remove folder...' }]
  : projectActions.value)
let menuAnchor: HTMLElement | undefined
const menuButton = ref<HTMLElement>()
const menu = ref<HTMLElement>()
const menuPosition = ref({ top: '0px', left: '0px' })
const sidebar = ref<HTMLElement>()
const containerWidth = ref(0)
const compact = ref(false)
const desktop = ref(false)
const railCollapsed = ref(false)
const isRail = computed(() => !props.grouped && desktop.value && railCollapsed.value)
const resizeActive = ref(true)
const preferredWidth = ref<number>()
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 200, 400))
const sidebarWidth = computed(() => clampSidebarWidth(preferredWidth.value ?? (compact.value ? 240 : 260), resizeBounds.value))
let resizeObserver: ResizeObserver | undefined
let listRequest: AbortController | undefined
let active = true
const projectWorkingStage = (sessions: SidebarSession[]) => sessions.map(session => props.stages[session.sessionId]).find(isWorkingStage)

function measureSidebar() {
  desktop.value = window.innerWidth > 700
  compact.value = window.innerWidth <= 1000
  const container = sidebar.value?.parentElement
  if (container?.getClientRects().length) containerWidth.value = container.getBoundingClientRect().width
}
function observeSidebar() {
  resizeActive.value = true
  resizeObserver?.disconnect()
  resizeObserver = new ResizeObserver(measureSidebar)
  if (sidebar.value?.parentElement) resizeObserver.observe(sidebar.value.parentElement)
  measureSidebar()
}

watch(() => reflectionActive.value ? undefined : props.activeSessionId
  ? props.sessions.find(session => session.sessionId === props.activeSessionId)?.projectId
  : props.draftProjectId, id => {
  selectedProjectId.value = id ?? ''
  if (id) expandedProjects.add(id)
}, { immediate: true })

async function loadProjects() {
  if (loading.value || !active) return
  const controller = new AbortController()
  listRequest = controller
  loading.value = true
  error.value = ''
  try {
    const result = await client.list(controller.signal)
    if (!controller.signal.aborted) projects.value = result
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load projects. Retry.'
  } finally {
    if (listRequest === controller) { loading.value = false; listRequest = undefined }
  }
}
async function projectRegistered(project: ProjectRecord) {
  selectedProjectId.value = project.id
  expandedProjects.add(project.id)
  const index = projects.value.findIndex(existing => existing.id === project.id)
  if (index < 0) projects.value.push(project)
  else projects.value[index] = project
  // The returned record keeps the folder usable even if refreshing the registry fails.
  listRequest?.abort()
  listRequest = undefined
  loading.value = false
  await loadProjects()
}
function toggleProject(id: string) {
  if (expandedProjects.has(id)) expandedProjects.delete(id)
  else expandedProjects.add(id)
}
function selectProject(id: string) {
  if (selectedProjectId.value === id) return
  selectedProjectId.value = id
  expandedProjects.add(id)
}
function selectConversation(id: string) {
  selectedProjectId.value = groups.value.reflections.some(session => session.sessionId === id)
    ? '' : props.sessions.find(session => session.sessionId === id)?.projectId ?? ''
  emit('select', id)
}
function startProjectDraft(project: ProjectRecord) {
  selectedProjectId.value = project.id
  expandedProjects.add(project.id)
  emit('draft', project)
}
async function showMenu(anchor: HTMLElement) {
  menuAnchor = anchor
  const rect = anchor.getBoundingClientRect()
  menuPosition.value = {
    top: `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - (menuActions.value.length * 40 + 18)))}px`,
    left: `${Math.max(8, Math.min(rect.right - 228, window.innerWidth - 236))}px`,
  }
  menuOpen.value = true
  await nextTick()
  menu.value?.querySelector<HTMLButtonElement>('button')?.focus()
}
function openMenu() {
  menuProject.value = undefined
  if (menuButton.value) return showMenu(menuButton.value)
}
function openProjectActions(project: ProjectRecord, event: MouseEvent | KeyboardEvent) {
  if (!(event.currentTarget instanceof HTMLElement)) return
  menuProject.value = project
  const anchor = event.currentTarget.matches('button') ? event.currentTarget
    : event.currentTarget.querySelector<HTMLButtonElement>('button.project-folder') ?? event.currentTarget
  void showMenu(anchor)
}
function toggleMenu() {
  if (menuOpen.value) closeMenu(true)
  else void openMenu()
}
function closeMenu(restoreFocus = false) {
  menuOpen.value = false
  if (restoreFocus) menuAnchor?.focus({ preventScroll: true })
}
function runAction(id: typeof PROJECT_ACTIONS[number]['id'] | 'remove' | 'move') {
  closeMenu(true)
  if (id === 'remove' || id === 'move') {
    if (menuProject.value) emit('manage', menuProject.value, id)
  } else if (id === 'scratch') { selectedProjectId.value = ''; emit('scratch') }
  else if (id === 'remote') { selectedProjectId.value = ''; emit('remote') }
  else dialogMode.value = id
}
function menuKeydown(event: KeyboardEvent) {
  const buttons = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button') ?? [])
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === 'Tab') { event.preventDefault(); closeMenu(true); return }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
    : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
function deactivate() {
  active = false
  resizeActive.value = false
  resizeObserver?.disconnect()
  closeMenu()
  dialogMode.value = null
  listRequest?.abort()
  listRequest = undefined
  loading.value = false
}
const closeOnResize = () => { closeMenu(); measureSidebar() }
watch(() => props.projectRevision, () => {
  listRequest?.abort()
  listRequest = undefined
  loading.value = false
  void loadProjects()
})
onMounted(() => { observeSidebar(); void loadProjects(); window.addEventListener('resize', closeOnResize) })
onActivated(() => { active = true; observeSidebar(); void loadProjects() })
onDeactivated(deactivate)
onUnmounted(() => { deactivate(); window.removeEventListener('resize', closeOnResize) })
</script>

<style scoped>
.projects-sidebar { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; box-sizing: border-box; border-right: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
.projects-sidebar.is-grouped { width: 100%; flex: 0 0 auto; border-right: 0; }
.is-grouped .projects-scroll { overflow: visible; flex: none; padding-bottom: 12px; }
.is-grouped .projects-header { min-height: 48px; padding: 8px 10px; gap: 4px; }
.is-grouped .projects-header h2 { flex: 1; min-width: 0; }
.organization-toggle { display: flex; align-items: center; gap: 6px; width: 100%; padding: 4px; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; text-align: left; overflow-wrap: anywhere; }
.organization-toggle span { flex-shrink: 0; }
.organization-toggle:hover { background: var(--c-bg-muted); }
.org-expanded { transform: rotate(90deg); }
.projects-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; min-height: 60px; padding: 12px 16px 8px 20px; }
.projects-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.projects-header-actions { display: flex; align-items: center; gap: 4px; }
.project-add { display: grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: var(--radius-control); color: var(--c-text-secondary); background: transparent; font-size: 21px; line-height: 1; }
.project-add:hover { color: var(--c-text); background: var(--c-bg-muted); }
.project-add:disabled { opacity: .5; cursor: wait; }
.projects-scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; overscroll-behavior: contain; padding: 4px 10px 16px; }
.project-group { margin-bottom: 4px; }
.folder-add { opacity: 0; }
.project-folder-row:hover .folder-add, .project-folder-row:focus-within .folder-add { opacity: 1; }
.empty-project { margin: 8px 6px 14px 26px; font-size: 12px; color: var(--c-text-secondary); line-height: 1.5; }
.legacy-chats { margin-top: 20px; }
.legacy-chats h3 { margin: 0 12px 8px; font-size: 12px; font-weight: 500; color: var(--c-text-secondary); }
.sidebar-note { margin: 8px 12px 16px; font-size: 12px; color: var(--c-text-secondary); line-height: 1.6; }
.sidebar-error { margin: 12px; color: var(--c-error); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.sidebar-error p { margin: 0 0 4px; }
.text-action { border: 0; padding: 3px 0; background: transparent; color: var(--c-text); text-decoration: underline; text-underline-offset: 3px; font: inherit; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.project-menu-backdrop { position: fixed; inset: 0; z-index: 900; }
.project-menu { position: fixed; display: flex; flex-direction: column; width: 228px; max-width: calc(100vw - 16px); padding: 5px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); }
.project-menu button { border: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: transparent; color: var(--c-text); font-size: 13px; text-align: left; }
.project-menu button:hover, .project-menu button:focus-visible { background: var(--c-bg-muted); }
.project-info { min-width: 0; }
.project-info-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 3em; overflow: hidden; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; font-weight: 600; }
.project-info p { margin: 6px 0; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.project-info .project-info-path { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 3em; overflow: hidden; font-size: 11px; line-height: 1.5; }
.project-info-new { margin-top: 6px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.project-info-new:hover { background: var(--c-bg-muted); }
.project-info-conversations { max-height: min(204px, 30dvh); margin-top: 12px; overflow: auto; overscroll-behavior: contain; }
.self-reflection-section { margin-top: 20px; }
.self-reflection-toggle { position: relative; display: flex; align-items: center; gap: 6px; width: 100%; min-width: 0; min-height: 34px; padding: 0 6px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text); text-align: left; font: inherit; font-size: 13px; cursor: pointer; }
.self-reflection-toggle:hover { background: var(--c-bg-muted); }
.self-reflection-toggle.active { background: var(--c-selection-bg); }
.self-reflection-caret { display: grid; place-items: center; flex: 0 0 20px; height: 28px; color: var(--c-text-secondary); }
.self-reflection-caret > span { width: 12px; height: 12px; }
.self-reflection-caret .open { transform: rotate(90deg); }
.self-reflection-icon { flex: 0 0 16px; width: 16px; height: 16px; color: var(--c-text-secondary); }
.self-reflection-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.self-reflection-count { font-size: 11px; color: var(--c-text-faint); }
.self-reflection-conversations { margin-top: 4px; }
.is-rail .projects-header { min-height: 0; padding: 12px 0; justify-content: center; }
.is-rail .projects-header-actions { flex-direction: column; gap: 8px; }
.is-rail .projects-header .project-add { width: 40px; height: 36px; flex-basis: 36px; }
.is-rail .projects-scroll { padding: 0 8px 16px; }
.is-rail .project-group { margin-bottom: 8px; }
.is-rail .legacy-chats { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--c-border); }
.is-rail .self-reflection-section { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--c-border); }
.is-rail .self-reflection-toggle { justify-content: center; width: 44px; min-height: 44px; margin-inline: auto; padding: 0; }
.is-rail .self-reflection-caret, .is-rail .self-reflection-label, .is-rail .self-reflection-count { display: none; }
.is-rail .self-reflection-icon { flex-basis: 20px; width: 20px; height: 20px; }
.is-rail .self-reflection-toggle :deep(.session-activity) { position: absolute; right: -2px; bottom: -2px; }
.is-rail .self-reflection-conversations { margin-top: 8px; }
.project-initial { text-align: center; font-size: 16px; line-height: 20px; font-weight: 600; }
.rail-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.rail-note { display: grid; place-items: center; min-height: 36px; margin: 4px 0 8px; }
.rail-status-button { display: grid; place-items: center; width: 40px; min-height: 40px; margin: 0 auto; padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-error); cursor: pointer; }
.rail-status-button:hover { background: var(--c-bg-muted); }
.is-rail .sidebar-error { margin: 8px 0; }
@media (hover: none), (max-width: 700px) { .folder-add { opacity: 1; } }
@media (min-width: 701px) { .projects-sidebar { width: var(--projects-width, 260px); } }
</style>
