<template>
  <div ref="root" class="project-dashboard-shell" :class="{ 'has-coordinator': coordinatorOpen, compact: !wide }"
    :style="{ '--coordinator-width': `${panelWidth}px` }">
    <main v-show="wide || !coordinatorOpen" ref="dashboardRoot" class="project-dashboard-tabs" tabindex="-1"
      @pointerdown.capture="activePane = 'dashboard'" @focusin="activePane = 'dashboard'">
      <FileWorkbench ref="workbench" :api-base="apiBase" :session-id="coordinatorId" :project-id="projectId"
        primary-label="Dashboard" primary-icon="i-lucide-layout-dashboard" :context-key="projectResourceKey(projectId, 'dashboard', coordinatorId)"
        :active="visible && (wide || !coordinatorOpen)" :keyboard-active="activePane === 'dashboard'" :initial-explorer-open="false"
        :knowledge-enabled="installation.uiScopes.includes('main:admin')" :knowledge-request="knowledgeRequest"
        :can-quote="installation.uiScopes.includes('chat:write')" @quote="quote" @image-context="imageContext" @image-busy="emit('image-busy', $event)"
        @conversation-visible="dashboardSelected = $event"
        @knowledge-navigation="(active, entryId) => emit('knowledge-navigation', active, entryId)"
        @project-navigation="emit('project-navigation', $event)">
        <template #actions>
          <button ref="coordinatorTrigger" type="button" class="coordinator-toggle" :aria-expanded="coordinatorOpen"
            :aria-controls="panelId" @click="coordinatorOpen ? closeCoordinator() : openCoordinator()">
            <span class="i-lucide-messages-square" aria-hidden="true" />Coordinator
          </button>
        </template>
        <template #default="{ active }">
          <ProjectWorkbench :api-base="apiBase" :project-id="projectId" :project-name="projectName" :visible="active"
            @navigate="emit('navigate', $event)" @compose="compose" @coordinator="openCoordinator" />
        </template>
      </FileWorkbench>
    </main>
    <aside v-show="coordinatorOpen" :id="panelId" class="project-coordinator-panel" aria-label="Coordinator conversation"
      @pointerdown.capture="activePane = 'coordinator'" @focusin="activePane = 'coordinator'">
      <SidebarResizer v-if="visible && wide && coordinatorOpen" edge="left" :model-value="panelWidth" :bounds="resizeBounds"
        label="Resize coordinator panel" :controls="panelId" @update:model-value="preferredPanelWidth = $event" />
      <header class="coordinator-heading">
        <h2>Coordinator</h2>
        <button type="button" class="coordinator-close" aria-label="Close coordinator panel" @click="closeCoordinator">
          <span class="i-lucide-panel-right-close" aria-hidden="true" />
        </button>
      </header>
      <slot :active="visible && coordinatorOpen" :keyboardActive="activePane === 'coordinator'" />
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useRoute } from 'vue-router'
import FileWorkbench from './files/FileWorkbench.vue'
import ProjectWorkbench from './ProjectWorkbench.vue'
import SidebarResizer from './SidebarResizer.vue'
import { clampSidebarWidth, sidebarWidthBounds } from '../sidebar-resize.ts'
import { projectResourceKey } from '../projects.ts'
import { ORCHESTRATOR_SESSION_ID as coordinatorId } from '../project-coordination.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'
import type { KnowledgeTabRequest, ProjectTab } from '../file-workbench.ts'
import type { ImageContextBusy, ImageContextUpdate } from '../image-context.ts'

const props = defineProps<{ apiBase: string; projectId: string; projectName: string; visible: boolean; knowledgeRequest?: KnowledgeTabRequest; childSessionId?: string }>()
const emit = defineEmits<{
  navigate: [id: string]; compose: [text: string]; quote: [text: string]
  'image-context': [update: ImageContextUpdate]; 'image-busy': [update: ImageContextBusy]
  'knowledge-navigation': [active: boolean, entryId?: string]; 'project-navigation': [tab?: ProjectTab]
  'dashboard-visible': [visible: boolean]
}>()
const installation = useInstallationContext(), route = useRoute()
const root = ref<HTMLElement>(), dashboardRoot = ref<HTMLElement>(), coordinatorTrigger = ref<HTMLButtonElement>()
const workbench = ref<InstanceType<typeof FileWorkbench>>()
const dashboardSelected = ref(true)
const panelId = `project-coordinator-${useId()}`
const coordinatorOpen = ref(false), containerWidth = ref(0), preferredPanelWidth = ref(400)
const activePane = ref<'dashboard' | 'coordinator'>('dashboard')
const wide = computed(() => containerWidth.value >= 1000)
const resizeBounds = computed(() => sidebarWidthBounds(containerWidth.value, 320, 640, 600))
const panelWidth = computed(() => clampSidebarWidth(preferredPanelWidth.value, resizeBounds.value))
let observer: ResizeObserver | undefined
let resizeFrame: number | undefined
async function openCoordinator() {
  coordinatorOpen.value = true
  activePane.value = 'coordinator'
  await nextTick()
  root.value?.querySelector<HTMLElement>('.project-coordinator-panel textarea:not(:disabled), .project-coordinator-panel button:not(:disabled)')?.focus()
}
async function closeCoordinator() {
  coordinatorOpen.value = false
  activePane.value = 'dashboard'
  await nextTick()
  if (coordinatorTrigger.value?.getClientRects().length) coordinatorTrigger.value.focus()
  else dashboardRoot.value?.focus()
}
async function compose(text: string) { await openCoordinator(); emit('compose', text) }
async function quote(text: string) { await openCoordinator(); emit('quote', text) }
async function imageContext(update: ImageContextUpdate) { await openCoordinator(); emit('image-context', update) }
watch(() => [props.visible, props.childSessionId, props.knowledgeRequest, route.name, route.params.projectId], () => {
  if (!props.visible) return
  if (props.childSessionId) void openCoordinator()
  else if (!wide.value && (props.knowledgeRequest || ['project-settings', 'agents'].includes(String(route.name)))) coordinatorOpen.value = false
}, { immediate: true })
onMounted(() => {
  let measured = false
  const measure = () => {
    const width = root.value?.clientWidth ?? 0
    if (!width) return
    containerWidth.value = width
    if (!measured) { measured = true; if (wide.value) coordinatorOpen.value = true }
  }
  measure()
  observer = new ResizeObserver(() => {
    if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
    resizeFrame = requestAnimationFrame(() => { resizeFrame = undefined; measure() })
  })
  if (root.value) observer.observe(root.value)
})
onUnmounted(() => {
  observer?.disconnect()
  if (resizeFrame !== undefined) cancelAnimationFrame(resizeFrame)
})
watch(() => dashboardSelected.value && (wide.value || !coordinatorOpen.value),
  visible => emit('dashboard-visible', visible), { immediate: true })
defineExpose({ showDashboard: () => {
  if (!wide.value) coordinatorOpen.value = false
  activePane.value = 'dashboard'
  workbench.value?.showConversation()
} })
</script>

<style scoped>
.project-dashboard-shell { display: grid; grid-template-columns: minmax(0, 1fr); flex: 1; min-width: 0; min-height: 0; }
.project-dashboard-shell.has-coordinator:not(.compact) { grid-template-columns: minmax(0, 1fr) var(--coordinator-width); }
.project-dashboard-tabs { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.project-coordinator-panel { position: relative; display: flex; flex-direction: column; min-width: 0; min-height: 0; border-left: 1px solid var(--c-border); background: var(--c-bg); }
.coordinator-heading { display: flex; align-items: center; justify-content: space-between; gap: 8px; min-height: 40px; padding: 0 8px 0 12px; border-bottom: 1px solid var(--c-border); }
.coordinator-heading h2 { margin: 0; font-size: 13px; font-weight: 600; }
.coordinator-toggle, .coordinator-close { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 6px 10px; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.coordinator-toggle { flex-shrink: 0; }
.coordinator-toggle:hover, .coordinator-close:hover { background: var(--c-bg-muted); color: var(--c-text); }
.coordinator-toggle[aria-expanded=true] { color: var(--c-primary); background: var(--c-selection-bg); }
.coordinator-toggle > span, .coordinator-close > span { width: 16px; height: 16px; flex-shrink: 0; }
.coordinator-toggle:focus-visible, .coordinator-close:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px), (pointer: coarse) { .coordinator-toggle, .coordinator-close { min-height: 44px; } }
</style>
