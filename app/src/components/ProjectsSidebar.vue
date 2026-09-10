<template>
  <aside id="sessions-sidebar" class="projects-sidebar sessions-sidebar" aria-label="Projects">
    <header class="projects-header">
      <h2>Projects</h2>
      <button ref="menuButton" class="project-add" aria-label="Add project" title="Add project" aria-haspopup="menu" :aria-expanded="menuOpen" aria-controls="project-actions" @click="toggleMenu" @keydown.down.prevent="openMenu">+</button>
    </header>
    <div class="projects-scroll">
      <p v-if="loading" class="sidebar-note" role="status">Loading projects…</p>
      <div v-if="error" class="sidebar-error" role="alert">
        <p>{{ error }}</p>
        <button class="text-action" @click="loadProjects">Retry projects</button>
      </div>
      <p v-if="!loading && !error && !projects.length" class="sidebar-note">Open a folder to keep its conversations together.</p>
      <section v-for="group in groups.projects" :key="group.project.id" class="project-group">
        <div class="project-folder-row" :class="{ selected: selectedProjectId === group.project.id }">
          <button class="project-folder" :title="group.project.path" :aria-expanded="expandedProjects.has(group.project.id)" @click="toggleProject(group.project.id)">
            <span class="project-chevron" aria-hidden="true">{{ expandedProjects.has(group.project.id) ? '⌄' : '›' }}</span>
            <svg class="folder-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M2.5 5.5h5l2 2h8v8.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-10.5a1 1 0 0 1 1-1Z" /></svg>
            <span class="project-name">{{ group.project.name }}</span>
          </button>
          <button class="project-add folder-add" :disabled="creatingProjectId !== ''" :aria-label="`New conversation in ${group.project.name}`" :title="`New conversation in ${group.project.name}`" @click="createProjectSession(group.project)">
            {{ creatingProjectId === group.project.id ? '…' : '+' }}
          </button>
        </div>
        <div v-if="expandedProjects.has(group.project.id)" class="project-conversations">
          <p v-if="!group.sessions.length" class="empty-project">No conversations yet</p>
          <ProjectSessionList :sessions="group.sessions" :active-session-id="activeSessionId" :collapsed="collapsed" :stages="stages" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
        </div>
      </section>
      <section class="legacy-chats" aria-labelledby="legacy-chats-heading">
        <h3 id="legacy-chats-heading">Chats</h3>
        <p v-if="sessionsLoading" class="sidebar-note" role="status">Loading conversations…</p>
        <div v-if="sessionsError" class="sidebar-error" role="alert"><p>{{ sessionsError }}</p><button class="text-action" @click="$emit('reload')">Retry conversations</button></div>
        <p v-if="!sessionsLoading && !groups.chats.length" class="sidebar-note">No unassociated conversations.</p>
        <ProjectSessionList :sessions="groups.chats" :active-session-id="activeSessionId" :collapsed="collapsed" :stages="stages" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
      </section>
      <div v-if="actionError" class="sidebar-error" role="alert"><p>{{ actionError }}</p><button v-if="failedProject" class="text-action" @click="createProjectSession(failedProject)">Retry new conversation</button></div>
      <div v-if="cloneStatus.state === 'unknown' || cloneStatus.state === 'failed'" class="sidebar-error" role="alert">
        <p>{{ cloneStatus.error }}</p><button class="text-action" @click="dialogMode = 'clone'">Review clone</button>
      </div>
    </div>
    <ProjectDialog :mode="dialogMode" :client="client" @close="dialogMode = null" @registered="projectRegistered" @status="cloneStatus = $event" />
    <Teleport to="body">
      <div v-if="menuOpen" class="project-menu-backdrop" @click.self="closeMenu(false)" @keydown.esc.prevent.stop="closeMenu(true)">
        <div id="project-actions" ref="menu" class="project-menu" role="menu" aria-label="Add project" :style="menuPosition" @keydown="menuKeydown">
          <button v-for="action in PROJECT_ACTIONS" :key="action.id" role="menuitem" @click="runAction(action.id)">{{ action.label }}</button>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import ProjectDialog from './ProjectDialog.vue'
import ProjectSessionList from './ProjectSessionList.vue'
import { createProjectsClient, type CloneView, type ProjectRecord } from '../projects-client.ts'
import { groupProjectSessions, PROJECT_ACTIONS, type SidebarSession } from '../projects-sidebar.ts'

const props = defineProps<{
  apiBase: string
  sessions: SidebarSession[]
  activeSessionId: string
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
  created: [sessionId: string, projectId: string]
}>()
const client = createProjectsClient(props.apiBase)
const projects = ref<ProjectRecord[]>([])
const groups = computed(() => groupProjectSessions(projects.value, props.sessions))
const expandedProjects = reactive(new Set<string>())
const selectedProjectId = ref('')
const loading = ref(false)
const error = ref('')
const actionError = ref('')
const failedProject = ref<ProjectRecord>()
const creatingProjectId = ref('')
const cloneStatus = ref<CloneView>({ state: 'idle' })
const dialogMode = ref<'open' | 'clone' | null>(null)
const menuOpen = ref(false)
const menuButton = ref<HTMLElement>()
const menu = ref<HTMLElement>()
const menuPosition = ref({ top: '0px', left: '0px' })
let listRequest: AbortController | undefined
let createRequest: AbortController | undefined
let active = true

watch(() => props.sessions.find(session => session.sessionId === props.activeSessionId)?.projectId, id => {
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
  selectedProjectId.value = id
  if (expandedProjects.has(id)) expandedProjects.delete(id)
  else expandedProjects.add(id)
}
function selectConversation(id: string) {
  selectedProjectId.value = props.sessions.find(session => session.sessionId === id)?.projectId ?? ''
  emit('select', id)
}
async function createProjectSession(project: ProjectRecord) {
  if (creatingProjectId.value) return
  actionError.value = ''
  failedProject.value = undefined
  creatingProjectId.value = project.id
  const controller = new AbortController()
  createRequest = controller
  try {
    const session = await client.createSession(project.id, controller.signal)
    if (controller.signal.aborted || !active) return
    selectedProjectId.value = project.id
    expandedProjects.add(project.id)
    emit('created', session.sessionId, project.id)
  } catch (cause) {
    if (!controller.signal.aborted) {
      failedProject.value = project
      actionError.value = cause instanceof Error ? cause.message : 'Could not create a conversation. Check Main and retry.'
    }
  } finally {
    if (createRequest === controller) { createRequest = undefined; creatingProjectId.value = '' }
  }
}
async function openMenu() {
  if (!menuButton.value) return
  const rect = menuButton.value.getBoundingClientRect()
  menuPosition.value = {
    top: `${Math.max(8, Math.min(rect.bottom + 6, window.innerHeight - 152))}px`,
    left: `${Math.max(8, Math.min(rect.right - 196, window.innerWidth - 204))}px`,
  }
  menuOpen.value = true
  await nextTick()
  menu.value?.querySelector<HTMLButtonElement>('button')?.focus()
}
function toggleMenu() {
  if (menuOpen.value) closeMenu(true)
  else void openMenu()
}
function closeMenu(restoreFocus = false) {
  menuOpen.value = false
  if (restoreFocus) menuButton.value?.focus({ preventScroll: true })
}
function runAction(id: typeof PROJECT_ACTIONS[number]['id']) {
  closeMenu(true)
  if (id === 'scratch') { selectedProjectId.value = ''; emit('scratch') }
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
  closeMenu()
  dialogMode.value = null
  listRequest?.abort()
  listRequest = undefined
  loading.value = false
  createRequest?.abort()
  createRequest = undefined
  creatingProjectId.value = ''
}
const closeOnResize = () => closeMenu()
onMounted(() => { void loadProjects(); window.addEventListener('resize', closeOnResize) })
onActivated(() => { active = true; void loadProjects() })
onDeactivated(deactivate)
onUnmounted(() => { deactivate(); window.removeEventListener('resize', closeOnResize) })
</script>

<style scoped>
.projects-sidebar { display: flex; flex-direction: column; min-width: 0; min-height: 0; border-right: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
.projects-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; min-height: 60px; padding: 12px 16px 8px 20px; }
.projects-header h2 { margin: 0; font-size: 15px; font-weight: 600; }
.project-add { display: grid; place-items: center; flex: 0 0 28px; width: 28px; height: 28px; padding: 0; border: 0; border-radius: 4px; color: var(--c-text-secondary); background: transparent; font-size: 21px; line-height: 1; }
.project-add:hover { color: var(--c-text); background: var(--c-bg-muted); }
.project-add:disabled { opacity: .5; cursor: wait; }
.projects-scroll { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 4px 10px 16px; }
.project-group { margin-bottom: 4px; }
.project-folder-row { display: flex; align-items: center; min-width: 0; padding-right: 4px; border-radius: 5px; }
.project-folder-row:hover { background: var(--c-bg-soft); }
.project-folder-row.selected { background: var(--c-bg-muted); }
.project-folder { display: flex; flex: 1; align-items: center; gap: 7px; min-width: 0; min-height: 38px; padding: 5px 2px 5px 6px; border: 0; background: transparent; color: var(--c-text); text-align: left; }
.project-chevron { flex: 0 0 12px; color: var(--c-text-secondary); font-size: 16px; text-align: center; }
.folder-icon { flex: 0 0 18px; width: 18px; height: 18px; color: var(--c-text-secondary); }
.project-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; font-weight: 500; }
.folder-add { opacity: 0; }
.project-folder-row:hover .folder-add, .project-folder-row:focus-within .folder-add { opacity: 1; }
.project-conversations { margin-left: 18px; }
.empty-project { margin: 8px 6px 14px 26px; font-size: 12px; color: var(--c-text-secondary); line-height: 1.5; }
.legacy-chats { margin-top: 20px; }
.legacy-chats h3 { margin: 0 12px 8px; font-size: 12px; font-weight: 500; color: var(--c-text-secondary); }
.sidebar-note { margin: 8px 12px 16px; font-size: 12px; color: var(--c-text-secondary); line-height: 1.6; }
.sidebar-error { margin: 12px; color: var(--c-error); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.sidebar-error p { margin: 0 0 4px; }
.text-action { border: 0; padding: 3px 0; background: transparent; color: var(--c-text); text-decoration: underline; text-underline-offset: 3px; font: inherit; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.project-menu-backdrop { position: fixed; inset: 0; z-index: 900; }
.project-menu { position: fixed; display: flex; flex-direction: column; width: 196px; max-width: calc(100vw - 16px); padding: 5px; border: 1px solid var(--c-border); border-radius: 7px; background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); }
.project-menu button { border: 0; padding: 10px 12px; border-radius: 3px; background: transparent; color: var(--c-text); font-size: 13px; text-align: left; }
.project-menu button:hover, .project-menu button:focus-visible { background: var(--c-bg-muted); }
@media (hover: none), (max-width: 700px) { .folder-add { opacity: 1; } }
</style>
