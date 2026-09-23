<template>
  <aside :id="grouped ? domId('sessions-sidebar') : 'sessions-sidebar'" ref="sidebar" class="folders-sidebar sessions-sidebar" :class="{ 'is-rail': isRail, 'is-grouped': grouped }" :aria-label="projectName || 'Folders'" :style="{ '--folders-width': `${isRail ? 64 : sidebarWidth}px` }">
    <SidebarResizer v-if="!grouped && desktop && resizeActive && !isRail" class="folders-resizer" :model-value="sidebarWidth" :bounds="resizeBounds"
      label="Resize folders" controls="sessions-sidebar" @update:model-value="preferredWidth = $event" />
    <header class="folders-header">
      <button v-if="grouped" type="button" class="project-toggle"
        :aria-label="`${groupExpanded ? 'Collapse' : 'Expand'} project ${projectName}`"
        :aria-expanded="groupExpanded" :aria-controls="domId('folders-navigation')" @click="groupExpanded = !groupExpanded">
        <span class="w-3.5 h-3.5" :class="loading ? 'i-lucide-loader-circle folder-loading-icon' : ['i-lucide-chevron-right', { 'org-expanded': groupExpanded }]" aria-hidden="true" />
      </button>
      <h2 v-if="!isRail"><slot v-if="grouped" name="project-name">{{ projectName }}</slot><template v-else><span class="folders-heading-icon w-4 h-4" :class="loading ? 'i-lucide-loader-circle folder-loading-icon' : 'i-lucide-folder'" aria-hidden="true" />Folders</template></h2>
      <div class="folders-header-actions">
        <slot name="project-actions" />
        <HoverInfo v-if="!grouped && desktop" :text="isRail ? 'Expand folders' : 'Collapse folders'"><template #default="{ triggerProps }">
          <button class="folder-action-button folders-rail-toggle" v-bind="triggerProps" :aria-label="isRail ? 'Expand folders' : 'Collapse folders'" :aria-expanded="!isRail" aria-controls="folders-navigation" @click="railCollapsed = !railCollapsed">
            <span :class="isRail && loading ? 'i-lucide-loader-circle folder-loading-icon' : isRail ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="w-4 h-4" aria-hidden="true" />
          </button>
        </template></HoverInfo>
        <HoverInfo text="Add folder"><template #default="{ triggerProps }">
          <button ref="menuButton" class="folder-action-button" v-bind="triggerProps" :aria-label="projectName ? `New work in ${projectName}` : 'Add folder'" aria-haspopup="menu" :aria-expanded="menuOpen" :aria-controls="domId('folder-actions')" @click="toggleMenu" @keydown.down.prevent="openMenu"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
        </template></HoverInfo>
      </div>
    </header>
    <span class="rail-visually-hidden" role="status">{{ loading ? 'Loading folders…' : '' }}</span>
    <div v-show="!grouped || groupExpanded" :id="domId('folders-navigation')" class="folders-scroll" :aria-busy="loading || sessionsLoading">
      <div v-if="error && !isRail" class="sidebar-error" role="alert">
        <p>{{ error }}</p>
        <button class="text-action" @click="loadFolders">Retry folders</button>
      </div>
      <HoverInfo v-if="error && isRail" :text="error"><template #default="{ triggerProps }"><button class="rail-status-button" v-bind="triggerProps" aria-label="Folders unavailable. Retry folders" @click="loadFolders"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
      <section v-for="group in groups.folders" :key="group.folder.id" class="folder-group">
        <TreeRow class="folder-folder-row" :selected="!activeSessionId && selectedFolderId === group.folder.id"
          :class="{ working: !!folderWorkingStage(group.sessions) || folderSubagents(group.sessions).running > 0 }" :icon-only="isRail"
          :label="group.folder.name" :title="group.folder.kind === 'remote' ? `${group.folder.workdir.nodeId}: ${group.folder.path}` : group.folder.path" :expanded="expandedFolders.has(group.folder.id)" separate-toggle
          button-class="folder-folder" toggle-class="folder-toggle"
          :toggle-label="`${expandedFolders.has(group.folder.id) ? 'Collapse' : 'Expand'} folder ${group.folder.name}`"
          @toggle="toggleFolder(group.folder.id)" @select="selectFolder(group.folder.id)"
          @contextmenu.prevent="grouped && openFolderActions(group.folder, $event)">
          <template #icon><span v-if="loading" class="i-lucide-loader-circle folder-loading-icon" /><span v-else-if="isRail" class="folder-initial">{{ railInitial(group.folder.name) }}</span><span v-else :class="group.folder.kind === 'remote' ? 'i-lucide-monitor' : expandedFolders.has(group.folder.id) ? 'i-lucide-folder-open' : 'i-lucide-folder'" /></template>
          <template #meta><SessionActivity v-if="folderWorkingStage(group.sessions) || folderHasSubagents(group.sessions)" :stage="folderWorkingStage(group.sessions)" :subagents="folderSubagents(group.sessions)" compact :icon-only="isRail" :title="undefined" /></template>
          <template #actions>
            <HoverInfo :text="`New conversation in ${group.folder.name}`"><template #default="{ triggerProps }"><button class="folder-action-button folder-add" v-bind="triggerProps" :aria-label="`New conversation in ${group.folder.name}`" @click="startFolderDraft(group.folder)"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
            <button v-if="grouped" class="folder-action-button folder-add folder-actions" :aria-label="`Folder actions for ${group.folder.name}`"
              aria-haspopup="menu" :aria-expanded="menuOpen && menuFolder?.id === group.folder.id" :aria-controls="domId('folder-actions')"
              @click="openFolderActions(group.folder, $event)" @keydown.down.prevent="openFolderActions(group.folder, $event)"><span class="i-lucide-ellipsis w-4 h-4" aria-hidden="true" /></button>
          </template>
          <template #info="{ close }">
            <div class="folder-info">
              <strong class="folder-info-title">{{ group.folder.name }}</strong>
              <p v-if="group.folder.kind === 'remote'">Remote device: {{ group.folder.workdir.nodeId }}</p>
              <p class="folder-info-path">{{ group.folder.path }}</p>
              <p>{{ group.sessions.length }} {{ group.sessions.length === 1 ? 'conversation' : 'conversations' }}</p>
              <button class="folder-info-new" @click="startFolderDraft(group.folder); close()">New conversation</button>
              <FolderSessionList v-if="group.sessions.length" class="folder-info-conversations" :sessions="group.sessions" :active-session-id="activeSessionId"
                :collapsed="collapsed" :stages="stages" :executions-by-owner="executionsByOwner" :show-info="false" @select="selectConversation($event); close()" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
            </div>
          </template>
        </TreeRow>
        <div v-if="!isRail && expandedFolders.has(group.folder.id) && group.sessions.length" class="folder-conversations">
          <FolderSessionList :sessions="group.sessions" :depth="1" :active-session-id="activeSessionId" :collapsed="collapsed" :stages="stages" :executions-by-owner="executionsByOwner" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
        </div>
      </section>
      <section v-if="chatGroups.chats.length || sessionsLoading || sessionsError" class="legacy-chats" :aria-labelledby="domId('legacy-chats-heading')">
        <h3 :id="domId('legacy-chats-heading')" :class="{ 'rail-visually-hidden': isRail }">Chats</h3>
        <p v-if="sessionsLoading" class="sidebar-note" :class="{ 'rail-note': isRail, 'rail-visually-hidden': sessions.length > 0 }" role="status"><span v-if="isRail" class="i-lucide-loader-circle w-4 h-4" aria-hidden="true" /><span :class="{ 'rail-visually-hidden': isRail }">Loading conversations…</span></p>
        <div v-if="sessionsError && !isRail" class="sidebar-error" role="alert"><p>{{ sessionsError }}</p><button class="text-action" @click="$emit('reload')">Retry conversations</button></div>
        <HoverInfo v-if="sessionsError && isRail" :text="sessionsError"><template #default="{ triggerProps }"><button class="rail-status-button" v-bind="triggerProps" aria-label="Conversations unavailable. Retry conversations" @click="$emit('reload')"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
        <FolderSessionList :sessions="chatGroups.chats" :depth="1" :rail="isRail" :active-session-id="activeSessionId" :collapsed="collapsed" :stages="stages" :executions-by-owner="executionsByOwner" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
      </section>
      <section v-for="bot in chatGroups.bots" :key="bot.id" class="bot-conversations" :data-bot-id="bot.id">
        <TreeRow :label="bot.label" :title="`${bot.label}\n${bot.connection.label}\n${bot.platform}\n${bot.id}`"
          :expanded="!collapsedBots.has(bot.id)" :icon-only="isRail" button-class="bot-toggle"
          :button-attrs="{ 'aria-controls': domId(`bot-conversations-${encodeURIComponent(bot.id)}`) }"
          :ariaLabel="`${collapsedBots.has(bot.id) ? 'Expand' : 'Collapse'} bot ${bot.label}: ${bot.connection.label}`"
          @select="toggleBot(bot.id)">
          <template #icon><span class="i-lucide-bot" /></template>
          <template #meta>
            <SessionActivity v-if="folderWorkingStage(bot.sessions) || folderHasSubagents(bot.sessions)" :stage="folderWorkingStage(bot.sessions)" :subagents="folderSubagents(bot.sessions)" compact :icon-only="isRail" :title="undefined" />
            <span class="bot-connection" :data-state="bot.connection.state" :title="bot.connection.label" aria-hidden="true">
              <span :class="bot.connection.icon" />
            </span>
          </template>
        </TreeRow>
        <div v-show="!collapsedBots.has(bot.id)" :id="domId(`bot-conversations-${encodeURIComponent(bot.id)}`)">
          <FolderSessionList v-if="!collapsedBots.has(bot.id)" :sessions="bot.sessions" :depth="1" :rail="isRail" :active-session-id="activeSessionId"
            :collapsed="collapsed" :stages="stages" :executions-by-owner="executionsByOwner" @select="selectConversation" @delete="$emit('delete', $event)" @toggle="$emit('toggle', $event)" />
        </div>
      </section>
      <AutomationSidebar :api-base="apiBase" :active="resizeActive && (!grouped || groupExpanded)" :rail="isRail"
        :groups="groups.automations" :stages="stages" :selected-id="selectedAutomationId || activeAutomation?.jobId"
        @select="$emit('automation', $event)" />
      <div v-if="cloneStatus.state === 'unknown' || cloneStatus.state === 'failed'" class="sidebar-error" role="alert">
        <template v-if="!isRail"><p>{{ cloneStatus.error }}</p><button class="text-action" @click="dialogMode = 'clone'">Review clone</button></template>
        <HoverInfo v-else :text="cloneStatus.error"><template #default="{ triggerProps }"><button class="rail-status-button" v-bind="triggerProps" aria-label="Review clone error" @click="dialogMode = 'clone'"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button></template></HoverInfo>
      </div>
    </div>
    <FolderDialog :mode="dialogMode" :client="client" @close="dialogMode = null" @registered="folderRegistered" @status="cloneStatus = $event" />
    <Teleport to="body">
      <div v-if="menuOpen" class="folder-menu-backdrop" @click.self="closeMenu(false)" @keydown.esc.prevent.stop="closeMenu(true)">
        <div :id="domId('folder-actions')" ref="menu" class="folder-menu" role="menu" :aria-label="menuFolder ? `Folder actions for ${menuFolder.name}` : 'Add folder'" :style="menuPosition" @keydown="menuKeydown">
          <button v-for="action in menuActions" :key="action.id" role="menuitem" @click="runAction(action.id)">{{ action.label }}</button>
        </div>
      </div>
    </Teleport>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, reactive, ref, useId, watch } from 'vue'
import FolderDialog from './FolderDialog.vue'
import FolderSessionList from './FolderSessionList.vue'
import TreeRow from './TreeRow.vue'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import SessionActivity from './SessionActivity.vue'
import AutomationSidebar from './AutomationSidebar.vue'
import { railInitial } from '../folder-rail.ts'
import { prominentWorkingStage } from '../session-activity.ts'
import { activeSubagentsByOwner, summarizeSubagents } from '../subagent-executions.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { createFoldersClient, type CloneView, type FolderRecord } from '../folders-client.ts'
import { automationSessionOwners, groupFolderSessions, FOLDER_ACTIONS, type SidebarSession } from '../folders-sidebar.ts'
import { ORCHESTRATOR_SESSION_ID } from '../project-coordination.ts'
import { groupBotConversations, restoreCollapsedBots, saveCollapsedBots, type SidebarBot } from '../bot-sidebar.ts'

const props = defineProps<{
  apiBase: string
  grouped?: boolean
  projectName?: string
  projectId?: string
  bots?: SidebarBot[]
  folderRevision?: number
  sessions: SidebarSession[]
  activeSessionId: string
  selectedAutomationId?: string
  draftFolderId?: string
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
  draft: [folder: FolderRecord]
  manage: [folder: FolderRecord, action: 'remove' | 'move']
  automation: [id: string]
}>()
const client = createFoldersClient(props.apiBase)
const groupExpanded = ref(true)
const componentId = useId()
const domId = (id: string) => props.grouped ? `${componentId}-${id}` : id
const folderActions = computed(() => FOLDER_ACTIONS.filter(action => action.id !== 'remote' || props.remoteFolders))
const folders = ref<FolderRecord[]>([])
const groups = computed(() => groupFolderSessions(folders.value, props.sessions))
const executionsByOwner = computed(() => activeSubagentsByOwner(props.sessions, props.stages))
const chatGroups = computed(() => groupBotConversations(groups.value.chats, props.projectId, props.bots))
const collapsedBots = ref(new Set<string>())
watch(() => [props.apiBase, props.projectId], () => {
  try { collapsedBots.value = props.projectId ? restoreCollapsedBots(window.localStorage, props.apiBase, props.projectId) : new Set() }
  catch { collapsedBots.value = new Set() }
}, { immediate: true })
function toggleBot(id: string) {
  if (collapsedBots.value.has(id)) collapsedBots.value.delete(id)
  else collapsedBots.value.add(id)
  if (props.projectId) {
    try { saveCollapsedBots(window.localStorage, props.apiBase, props.projectId, collapsedBots.value) }
    catch { /* Disclosure still works when browser storage is unavailable. */ }
  }
}
const activeAutomation = computed(() => automationSessionOwners(props.sessions).get(props.activeSessionId))
const expandedFolders = reactive(new Set<string>())
const selectedFolderId = ref('')
const loading = ref(false)
const error = ref('')
const cloneStatus = ref<CloneView>({ state: 'idle' })
const dialogMode = ref<'open' | 'clone' | null>(null)
const menuOpen = ref(false)
const menuFolder = ref<FolderRecord>()
const menuActions = computed(() => menuFolder.value
  ? [{ id: 'move' as const, label: 'Move to project...' }, { id: 'remove' as const, label: 'Remove folder...' }]
  : folderActions.value)
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
const folderWorkingStage = (sessions: SidebarSession[]) => prominentWorkingStage(sessions.map(session => props.stages[session.sessionId]))
const folderSubagents = (sessions: SidebarSession[]) => summarizeSubagents(sessions.flatMap(session => executionsByOwner.value.get(session.sessionId) ?? []), props.stages)
const folderHasSubagents = (sessions: SidebarSession[]) => {
  const { running, waiting, pending } = folderSubagents(sessions)
  return running + waiting + pending > 0
}

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

watch(() => activeAutomation.value || props.activeSessionId === ORCHESTRATOR_SESSION_ID ? undefined : props.activeSessionId
  ? props.sessions.find(session => session.sessionId === props.activeSessionId)?.folderId
  : props.draftFolderId, id => {
  selectedFolderId.value = id ?? ''
  if (id) expandedFolders.add(id)
}, { immediate: true })

async function loadFolders() {
  if (loading.value || !active) return
  const controller = new AbortController()
  listRequest = controller
  loading.value = true
  error.value = ''
  try {
    const result = await client.list(controller.signal)
    if (!controller.signal.aborted) folders.value = result
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load folders. Retry.'
  } finally {
    if (listRequest === controller) { loading.value = false; listRequest = undefined }
  }
}
async function folderRegistered(folder: FolderRecord) {
  selectedFolderId.value = folder.id
  expandedFolders.add(folder.id)
  const index = folders.value.findIndex(existing => existing.id === folder.id)
  if (index < 0) folders.value.push(folder)
  else folders.value[index] = folder
  // The returned record keeps the folder usable even if refreshing the registry fails.
  listRequest?.abort()
  listRequest = undefined
  loading.value = false
  await loadFolders()
}
function toggleFolder(id: string) {
  if (expandedFolders.has(id)) expandedFolders.delete(id)
  else expandedFolders.add(id)
}
function selectFolder(id: string) {
  if (selectedFolderId.value === id) return
  selectedFolderId.value = id
  expandedFolders.add(id)
}
function selectConversation(id: string) {
  selectedFolderId.value = id === ORCHESTRATOR_SESSION_ID || automationSessionOwners(props.sessions).has(id)
    ? '' : props.sessions.find(session => session.sessionId === id)?.folderId ?? ''
  emit('select', id)
}
function startFolderDraft(folder: FolderRecord) {
  selectedFolderId.value = folder.id
  expandedFolders.add(folder.id)
  emit('draft', folder)
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
  menuFolder.value = undefined
  if (menuButton.value) return showMenu(menuButton.value)
}
function openFolderActions(folder: FolderRecord, event: MouseEvent | KeyboardEvent) {
  if (!(event.currentTarget instanceof HTMLElement)) return
  menuFolder.value = folder
  const anchor = event.currentTarget.matches('button') ? event.currentTarget
    : event.currentTarget.querySelector<HTMLButtonElement>('button.folder-folder') ?? event.currentTarget
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
function runAction(id: typeof FOLDER_ACTIONS[number]['id'] | 'remove' | 'move') {
  closeMenu(true)
  if (id === 'remove' || id === 'move') {
    if (menuFolder.value) emit('manage', menuFolder.value, id)
  } else if (id === 'scratch') { selectedFolderId.value = ''; emit('scratch') }
  else if (id === 'remote') { selectedFolderId.value = ''; emit('remote') }
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
watch(() => props.folderRevision, () => {
  listRequest?.abort()
  listRequest = undefined
  loading.value = false
  void loadFolders()
})
onMounted(() => { observeSidebar(); void loadFolders(); window.addEventListener('resize', closeOnResize) })
onActivated(() => { active = true; observeSidebar(); void loadFolders() })
onDeactivated(deactivate)
onUnmounted(() => { deactivate(); window.removeEventListener('resize', closeOnResize) })
</script>

<style scoped>
.folders-sidebar { --tree-row-height: var(--sidebar-row-height); --tree-row-inset: var(--sidebar-row-inset); --tree-indent: var(--sidebar-indent); --tree-gap: var(--sidebar-heading-gap); --tree-icon-gap: var(--sidebar-icon-gap); --tree-disclosure: var(--sidebar-disclosure); position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; box-sizing: border-box; border-right: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
.folders-sidebar.is-grouped { width: 100%; flex: 0 0 auto; border-right: 0; }
.is-grouped .folders-scroll { overflow: visible; scrollbar-gutter: auto; flex: none; padding-bottom: 0; }
.is-grouped .folders-header { min-height: var(--sidebar-project-height); padding: 0 calc(var(--sidebar-gutter) + var(--sidebar-row-inset)); gap: var(--sidebar-heading-gap); }
.is-grouped .folders-header h2 { flex: 1; min-width: 0; }
.project-toggle { display: grid; place-items: center; flex-shrink: 0; width: var(--sidebar-disclosure); height: var(--sidebar-row-height); padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.project-toggle:hover { background: var(--c-bg-muted); }
.project-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.org-expanded { transform: rotate(90deg); }
.folders-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; min-height: 48px; padding: 8px 12px; }
.folders-header h2 { margin: 0; font-size: 15px; line-height: 20px; font-weight: 600; }
.folders-heading-icon { display: inline-block; margin-inline-end: 8px; vertical-align: -2px; }
.folder-loading-icon { animation: folder-loading-spin 1s linear infinite; }
@keyframes folder-loading-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .folder-loading-icon { animation: none; } }
.folders-header-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; }
.folder-action-button { display: grid; place-items: center; flex: 0 0 var(--sidebar-action-size); width: var(--sidebar-action-size); height: var(--sidebar-action-size); padding: 0; border: 0; border-radius: var(--radius-control); color: var(--c-text-secondary); background: transparent; font-size: 21px; line-height: 1; }
.folder-action-button:hover { color: var(--c-text); background: var(--c-bg-muted); }
.folder-action-button:disabled { opacity: .5; cursor: wait; }
.folders-scroll { flex: 1; min-height: 0; overflow-y: auto; scrollbar-gutter: stable; overscroll-behavior: contain; padding: var(--sidebar-heading-gap) var(--sidebar-gutter) var(--sidebar-section-gap); }
.folders-scroll:empty { padding-block: 0; }
.folder-add { opacity: 0; }
.folder-folder-row:hover .folder-add, .folder-folder-row:focus-within .folder-add { opacity: 1; }
.legacy-chats { margin-top: var(--sidebar-section-gap); }
.legacy-chats:first-child { margin-top: 0; }
.bot-connection { display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; margin-inline-start: 6px; flex-shrink: 0; color: var(--c-text-secondary); }
.bot-connection > span { width: 13px; height: 13px; }
.bot-connection[data-state="connected"] { color: var(--c-success); }
.bot-connection[data-state="restart-required"] { color: var(--c-warn); }
.bot-connection[data-state="error"] { color: var(--c-error); }
.legacy-chats h3 { margin: 0 0 var(--sidebar-heading-gap); padding-inline: calc(var(--sidebar-row-inset) + var(--sidebar-disclosure) + var(--sidebar-heading-gap)) var(--sidebar-row-inset); font-size: 12px; line-height: 20px; font-weight: 500; color: var(--c-text-secondary); }
.sidebar-note { margin: 8px 12px 16px; font-size: 12px; color: var(--c-text-secondary); line-height: 1.6; }
.sidebar-error { margin: 12px; color: var(--c-error); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
.sidebar-error p { margin: 0 0 4px; }
.text-action { border: 0; padding: 3px 0; background: transparent; color: var(--c-text); text-decoration: underline; text-underline-offset: 3px; font: inherit; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 1px; }
.folder-menu-backdrop { position: fixed; inset: 0; z-index: 900; }
.folder-menu { position: fixed; display: flex; flex-direction: column; width: 228px; max-width: calc(100vw - 16px); padding: 5px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay); background: var(--c-bg-card); box-shadow: 0 8px 24px var(--c-shadow); }
.folder-menu button { border: 0; padding: 10px 12px; border-radius: var(--radius-sm); background: transparent; color: var(--c-text); font-size: 13px; text-align: left; }
.folder-menu button:hover, .folder-menu button:focus-visible { background: var(--c-bg-muted); }
.folder-info { min-width: 0; }
.folder-info-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 3em; overflow: hidden; overflow-wrap: anywhere; font-size: 14px; line-height: 1.5; font-weight: 600; }
.folder-info p { margin: 6px 0; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.folder-info .folder-info-path { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; max-height: 3em; overflow: hidden; font-size: 11px; line-height: 1.5; }
.folder-info-new { margin-top: 6px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: transparent; color: var(--c-text); font: inherit; cursor: pointer; }
.folder-info-new:hover { background: var(--c-bg-muted); }
.folder-info-conversations { max-height: min(204px, 30dvh); margin-top: 12px; overflow: auto; overscroll-behavior: contain; }
.is-rail .folders-header { min-height: 0; padding: 12px 0; justify-content: center; }
.is-rail .folders-header-actions { flex-direction: column; gap: 8px; }
.is-rail .folders-header .folder-action-button { width: 40px; height: 36px; flex-basis: 36px; }
.is-rail .folders-scroll { padding: 0 8px 16px; }
.is-rail .folder-group { margin-bottom: 8px; }
.is-rail .legacy-chats { margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--c-border); }
.folder-initial { text-align: center; font-size: 16px; line-height: 20px; font-weight: 600; }
.rail-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.rail-note { display: grid; place-items: center; min-height: 36px; margin: 4px 0 8px; }
.rail-status-button { display: grid; place-items: center; width: 40px; min-height: 40px; margin: 0 auto; padding: 0; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-error); cursor: pointer; }
.rail-status-button:hover { background: var(--c-bg-muted); }
.is-rail .sidebar-error { margin: 8px 0; }
@media (hover: none), (max-width: 700px) { .folder-add { opacity: 1; } }
@media (min-width: 701px) { .folders-sidebar { width: var(--folders-width, 260px); } }
</style>
