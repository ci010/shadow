<template>
  <div ref="workspaceElement" class="organizations-workspace">
    <button class="organizations-mobile-toggle btn btn-sm" :aria-expanded="sidebarOpen" aria-controls="organizations-sidebar" @click="sidebarOpen = !sidebarOpen">Organizations</button>
    <button v-if="sidebarOpen" class="organizations-backdrop" aria-label="Close organizations" @click="sidebarOpen = false" />
    <aside id="organizations-sidebar" class="organizations-sidebar" :class="{ open: sidebarOpen, 'is-rail': isRail }"
      :style="{ '--organizations-width': `${isRail ? 64 : sidebarWidth}px` }" aria-label="Organizations">
      <SidebarResizer v-if="desktop && !isRail && visible" :model-value="sidebarWidth" :bounds="resizeBounds"
        label="Resize organizations" controls="organizations-sidebar" @update:model-value="preferredWidth = $event" />
      <header class="organizations-heading">
        <h1 v-if="!isRail">Organizations</h1>
        <div class="organizations-heading-actions">
          <HoverInfo v-if="desktop" :text="isRail ? 'Expand organizations' : 'Collapse organizations'"><template #default="{ triggerProps }">
            <button class="organization-add organizations-rail-toggle" v-bind="triggerProps" :aria-label="isRail ? 'Expand organizations' : 'Collapse organizations'"
              :aria-expanded="!isRail" aria-controls="organization-groups" @click="railCollapsed = !railCollapsed">
              <span :class="isRail ? 'i-lucide-panel-left-open' : 'i-lucide-panel-left-close'" class="w-4 h-4" aria-hidden="true" />
            </button>
          </template></HoverInfo>
          <button v-if="!isRail" class="organization-add" aria-label="Add organization" :aria-expanded="creating" @click="creating = !creating"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
        </div>
      </header>
      <nav v-if="isRail" class="organization-rail" aria-label="Organization shortcuts">
        <HoverInfo v-for="organization in organizations" :key="organization.id" :text="organization.name"><template #default="{ triggerProps }">
          <button class="organization-badge" v-bind="triggerProps" :class="{ selected: selected?.organizationId === organization.id }"
            :aria-label="`Show ${organization.name} projects`" @click="showOrganization(organization.id)">{{ railInitial(organization.name) }}</button>
        </template></HoverInfo>
        <HoverInfo text="Add organization"><template #default="{ triggerProps }">
          <button class="organization-badge organization-rail-add" v-bind="triggerProps" aria-label="Add organization" @click="railCollapsed = false; creating = true"><span class="i-lucide-plus w-4 h-4" aria-hidden="true" /></button>
        </template></HoverInfo>
        <button v-if="error" class="organization-badge organization-error" aria-label="Organizations unavailable. Retry catalog" @click="refresh"><span class="i-lucide-circle-alert w-4 h-4" aria-hidden="true" /></button>
      </nav>
      <form v-if="creating && !isRail" class="organization-create" @submit.prevent="createOrganization">
        <label>Organization name<input v-model="name" required autocomplete="off" :disabled="saving" /></label>
        <button class="btn btn-sm" :disabled="saving || !name.trim()">{{ saving ? 'Creating...' : 'Create organization' }}</button>
      </form>
      <p v-if="loading && !isRail" class="organization-note" role="status">Loading organizations...</p>
      <div v-if="error && !isRail" class="organization-note organization-error" role="alert"><p>{{ error }}</p><button class="btn btn-sm" @click="refresh">Retry catalog</button></div>
      <div v-show="!isRail" id="organization-groups" class="organization-groups">
        <OrganizationGroup v-for="organization in organizations" :key="organization.id" :api-base="apiBase" :organization="organization"
          :data-organization-id="organization.id" :project-revision="projectRevision"
          :selected-organization-id="selected?.organizationId ?? ''" :selected-session-id="selected?.sessionId ?? ''"
          :draft-project-id="selected?.project?.id" :remote-folders="installation.mode === 'main'"
          @select="selectSession(organization.id, $event)" @draft="(project, remote) => startDraft(organization.id, project, remote)"
          @deleted="deleted(organization.id, $event)" @manage="(project, action) => manageProject(organization, project, action)" />
      </div>
      <p v-if="notice && !isRail" class="organization-notice" role="status">{{ notice }}</p>
    </aside>
    <div class="organization-conversations">
      <section v-if="!selected" class="organization-empty">
        <h1>Where would you like to work?</h1>
        <p>Choose a project or start a chat in an organization. Each keeps its own Home and model defaults.</p>
        <button v-for="organization in organizations" :key="organization.id" class="btn" @click="startDraft(organization.id)">Start in {{ organization.name }}</button>
        <button v-if="!organizations.length && !loading && !error" class="btn" @click="creating = true">Create an organization</button>
      </section>
      <OrganizationConversation v-for="resource in resources" :key="resource.key"
        :ref="component => setConversation(resource.key, component)"
        v-show="selected?.key === resource.key" :visible="visible && selected?.key === resource.key"
        :api-base="organizationBase(apiBase, resource.organizationId)" :organization-id="resource.organizationId"
        :organization-name="organizations.find(item => item.id === resource.organizationId)?.name ?? resource.organizationId"
        :session-id="resource.sessionId" :initial-project="resource.project" :open-remote="resource.openRemote"
        :child-session-id="resource.childSessionId"
        @navigate="(id, child) => navigate(resource.organizationId, id, child)" @prepared="prepared(resource.key, $event)" />
    </div>
    <ProjectOwnershipDialog v-if="projectOperation" :key="`${projectOperation.organization.id}:${projectOperation.project.id}:${projectOperation.action}`"
      :api-base="apiBase" :organization="projectOperation.organization" :organizations="organizations"
      :project="projectOperation.project" :action="projectOperation.action" @close="projectOperation = undefined"
      @refresh="projectOperation = undefined; projectRevision++" @changed="projectChanged" />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import OrganizationGroup from './OrganizationGroup.vue'
import OrganizationConversation from './OrganizationConversation.vue'
import ProjectOwnershipDialog from './ProjectOwnershipDialog.vue'
import SidebarResizer from './SidebarResizer.vue'
import HoverInfo from './HoverInfo.vue'
import { organizationBase } from '../api-url.ts'
import { createOrganizationsClient, organizationChatLocation, type OrganizationRecord } from '../organizations.ts'
import { createConversationResources, type ConversationResource } from '../organization-workspaces.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import type { ProjectRecord } from '../projects-client.ts'
import { railInitial } from '../project-rail.ts'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { DEFAULT_ORGANIZATION_SIDEBAR, parseOrganizationSidebarPreferences } from '../organization-sidebar.ts'

defineOptions({ name: 'OrganizationsWorkspace' })
const props = withDefaults(defineProps<{ apiBase: string; visible?: boolean }>(), { visible: true })
const route = useRoute()
const router = useRouter()
const installation = useInstallationContext()
const organizations = ref<OrganizationRecord[]>([])
const registry = createConversationResources()
const resources = shallowRef<ConversationResource[]>([])
const selected = shallowRef<ConversationResource>()
const instances = new Map<string, InstanceType<typeof OrganizationConversation>>()
const sidebarOpen = ref(false)
const creating = ref(false)
const name = ref('')
const saving = ref(false)
const loading = ref(true)
const error = ref('')
const workspaceElement = ref<HTMLElement>()
const desktop = ref(false)
const railCollapsed = ref(false)
const preferredWidth = ref(DEFAULT_ORGANIZATION_SIDEBAR.width)
const containerWidth = ref(800)
const isRail = computed(() => desktop.value && railCollapsed.value)
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 200, 440))
const sidebarWidth = computed(() => clampSidebarWidth(preferredWidth.value, resizeBounds.value))
const storageKey = `shadow:organizations-sidebar:${props.apiBase}`
let sidebarObserver: ResizeObserver | undefined
const projectRevision = ref(0)
const notice = ref('')
const projectOperation = shallowRef<{ organization: OrganizationRecord; project: ProjectRecord; action: 'remove' | 'move' }>()
let request: AbortController | undefined
let mutation: AbortController | undefined
function measureSidebar() {
  desktop.value = window.innerWidth > 700
  const width = workspaceElement.value?.getBoundingClientRect().width
  if (width) containerWidth.value = width
}
async function showOrganization(id: string) {
  railCollapsed.value = false
  await nextTick()
  const group = [...(workspaceElement.value?.querySelectorAll<HTMLElement>('[data-organization-id]') ?? [])]
    .find(element => element.dataset.organizationId === id)
  const toggle = group?.querySelector<HTMLButtonElement>('.organization-toggle')
  if (toggle?.getAttribute('aria-expanded') === 'false') {
    toggle.click()
    await nextTick()
  }
  group?.scrollIntoView({ block: 'nearest' })
  toggle?.focus({ preventScroll: true })
}
function manageProject(organization: OrganizationRecord, project: ProjectRecord, action: 'remove' | 'move') {
  projectOperation.value = { organization, project, action }
}
function projectChanged(project?: ProjectRecord) {
  const operation = projectOperation.value
  if (!operation) return
  const target = organizations.value.find(org => org.id === project?.organizationId)
  notice.value = project ? `${operation.project.name} moved to ${target?.name ?? project.organizationId}.`
    : `${operation.project.name} removed from ${operation.organization.name}.`
  notice.value += ' Files are unchanged; existing conversations remain in the original organization.'
  projectOperation.value = undefined
  projectRevision.value++
  void showOrganization(operation.organization.id)
}
function setConversation(key: string, component: Element | ComponentPublicInstance | null) {
  if (component) instances.set(key, component as InstanceType<typeof OrganizationConversation>)
  else instances.delete(key)
}
function publish(resource: ConversationResource) {
  selected.value = resource
  resources.value = [...registry.resources]
  sidebarOpen.value = false
}
function syncRoute() {
  if (!props.visible || route.name !== 'chat') return
  const organizationId = typeof route.params.organizationId === 'string' ? route.params.organizationId : ''
  if (!organizationId || !organizations.value.some(org => org.id === organizationId)) {
    selected.value = undefined
    if (organizationId && !loading.value) error.value = 'This organization is unavailable. Refresh the catalog or choose another organization.'
    return
  }
  const sessionId = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  if (sessionId) {
    const resource = registry.session({ organizationId, sessionId })
    resource.childSessionId = typeof route.query.child === 'string' ? route.query.child : undefined
    publish(resource)
  }
  else if (selected.value?.organizationId !== organizationId || selected.value.sessionId) publish(registry.draft(organizationId))
}
async function refresh() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    const result = await createOrganizationsClient(props.apiBase).list(controller.signal)
    if (controller.signal.aborted) return
    organizations.value = result
    syncRoute()
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load organizations. Retry.'
  } finally { if (request === controller) { loading.value = false; request = undefined } }
}
async function createOrganization() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const controller = new AbortController()
  mutation = controller
  try {
    const organization = await createOrganizationsClient(props.apiBase).save(name.value, undefined, controller.signal)
    if (controller.signal.aborted) return
    organizations.value.push(organization)
    name.value = ''
    creating.value = false
    startDraft(organization.id)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not create organization. Retry.'
  } finally { saving.value = false }
}
function startDraft(organizationId: string, project?: ProjectRecord, remote = false) {
  const resource = registry.draft(organizationId, project, remote)
  publish(resource)
  void router.push(organizationChatLocation(resource))
}
function navigate(organizationId: string, sessionId: string, child?: string) {
  if (!sessionId) { startDraft(organizationId); return }
  const resource = registry.session({ organizationId, sessionId })
  resource.childSessionId = child
  publish(resource)
  void router.push({ ...organizationChatLocation({ organizationId, sessionId }), query: child ? { child } : {} })
}
function selectSession(organizationId: string, sessionId: string) {
  if (selected.value?.organizationId === organizationId) {
    const instance = instances.get(selected.value.key)
    if (instance) { instance.requestSession(sessionId); sidebarOpen.value = false; return }
  }
  navigate(organizationId, sessionId)
}
function prepared(key: string, sessionId: string) {
  const resource = registry.prepared(key, sessionId)
  resources.value = [...registry.resources]
  // A delayed upload/prepare in A must not navigate away from B.
  if (selected.value?.key === key && props.visible && route.name === 'chat') {
    void router.replace({ ...organizationChatLocation(resource), query: resource.childSessionId ? { child: resource.childSessionId } : {} })
  }
}
function deleted(organizationId: string, sessionId: string) {
  for (let i = registry.resources.length - 1; i >= 0; i--) {
    const resource = registry.resources[i]
    if (resource.organizationId === organizationId && resource.sessionId === sessionId) registry.resources.splice(i, 1)
  }
  resources.value = [...registry.resources]
  if (selected.value?.organizationId === organizationId && selected.value.sessionId === sessionId) startDraft(organizationId)
}
watch(() => [route.fullPath, props.visible], syncRoute)
watch([preferredWidth, railCollapsed], ([width, collapsed]) => {
  try { window.localStorage.setItem(storageKey, JSON.stringify({ width, collapsed })) }
  catch { console.warn('[organizations] Could not save sidebar preferences; layout will reset after reload.') }
})
const onCatalogChanged = () => { void refresh() }
onMounted(() => {
  try {
    const preferences = parseOrganizationSidebarPreferences(window.localStorage.getItem(storageKey))
    preferredWidth.value = preferences.width
    railCollapsed.value = preferences.collapsed
  } catch { console.warn('[organizations] Could not restore sidebar preferences; using the default layout.') }
  sidebarObserver = new ResizeObserver(measureSidebar)
  if (workspaceElement.value) sidebarObserver.observe(workspaceElement.value)
  measureSidebar()
  void refresh()
  window.addEventListener('resize', measureSidebar)
  window.addEventListener('shadow:organizations-changed', onCatalogChanged)
})
onUnmounted(() => {
  request?.abort(); mutation?.abort(); sidebarObserver?.disconnect()
  window.removeEventListener('resize', measureSidebar)
  window.removeEventListener('shadow:organizations-changed', onCatalogChanged)
})
</script>

<style scoped>
.organizations-workspace { display: flex; position: relative; flex: 1; min-width: 0; min-height: 0; height: 100%; }
.organizations-sidebar { position: relative; display: flex; flex-direction: column; flex: 0 0 var(--organizations-width, 270px); width: var(--organizations-width, 270px); min-width: 0; min-height: 0; border-right: 1px solid var(--c-border); background: var(--c-bg-card); }
.organizations-heading { display: flex; align-items: center; justify-content: space-between; padding: 16px; }
.organizations-heading h1 { margin: 0; min-width: 0; font-size: 15px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; }
.organizations-heading-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; }
.organization-add { display: grid; place-items: center; border: 0; width: 28px; height: 28px; padding: 0; color: var(--c-text); background: transparent; }
.organization-add:hover { background: var(--c-bg-muted); }
.organization-groups { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.is-rail .organizations-heading { justify-content: center; padding: 12px 0; }
.is-rail .organizations-rail-toggle { width: 40px; height: 36px; }
.organization-rail { display: flex; flex: 1; min-height: 0; overflow-y: auto; align-items: center; flex-direction: column; gap: 12px; padding: 4px 8px 16px; }
.organization-badge { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; padding: 0; border: 1px solid var(--c-border); border-radius: var(--radius-control); color: var(--c-text); background: var(--c-bg-muted); font: inherit; font-size: 16px; font-weight: 600; cursor: pointer; }
.organization-badge:hover { background: var(--c-bg-soft); }
.organization-badge.selected { background: var(--c-selection-bg); border-color: var(--c-blue); }
.organization-rail-add { color: var(--c-text-secondary); background: transparent; }
.organization-notice { margin: 0; padding: 12px 16px; border-top: 1px solid var(--c-border); font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.organization-conversations { display: flex; flex: 1; min-width: 0; min-height: 0; }
.organization-empty { align-self: center; margin: auto; padding: 24px; max-width: 560px; }
.organization-empty h1 { font-size: 24px; }
.organization-empty p { color: var(--c-text-secondary); line-height: 1.6; }
.organization-empty .btn { display: block; margin: 12px 0; }
.organization-note, .organization-create { margin: 0; padding: 12px 16px; font-size: 13px; }
.organization-error { color: var(--c-error); overflow-wrap: anywhere; }
.organization-create label { display: grid; gap: 8px; margin-bottom: 10px; }
.organization-create input { width: 100%; min-width: 0; padding: 8px; border: 1px solid var(--c-border); color: var(--c-text); background: var(--c-bg-input); font: inherit; }
button:focus-visible, input:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.organizations-mobile-toggle, .organizations-backdrop { display: none; }
@media (max-width: 700px) {
  .organizations-workspace { padding-top: 42px; }
  .organizations-mobile-toggle { display: block; position: absolute; top: 4px; left: 8px; min-height: 34px; }
  .organizations-sidebar { display: none; position: absolute; inset: 42px auto 0 0; z-index: 50; width: min(300px, calc(100% - 40px)); }
  .organizations-sidebar.open { display: flex; }
  .organizations-backdrop { display: block; position: absolute; inset: 42px 0 0; z-index: 49; border: 0; background: var(--c-shadow); }
}
</style>
