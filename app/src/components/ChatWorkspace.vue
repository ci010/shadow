<template>
  <div ref="workspace" class="conversation-workspace" :class="{ 'has-child': childId, 'is-split': split, 'is-resizing': !!drag }" :style="split ? { gridTemplateColumns: `minmax(0, 1fr) ${SPLIT_HANDLE_WIDTH}px ${childWidth}px` } : undefined">
    <div v-show="!childId || wide || route.name === 'project-settings' || route.name === 'agents'" class="primary-conversation" @pointerdown.capture="activePane = 'primary'" @focusin="activePane = 'primary'">
      <ChatTab ref="primary" :api-base="apiBase" :embedded="embedded" enable-child-pane :child-session-id="childId"
        :knowledge-request="knowledgeRequest" @knowledge-navigation="(active, entryId) => emit('knowledge-navigation', active, entryId)"
        @project-navigation="emit('project-navigation', $event)"
        :project-id="projectId" :project-name="projectName" :managed="managed" :session-id="sessionId" :initial-folder="initialFolder" :open-remote="openRemote" :automation-run="automationRun"
        :visible="visible && ['chat', 'project-settings', 'agents'].includes(String(route.name)) && (!childId || wide || route.name !== 'chat')" :keyboard-active="keyboardActive && visible && (!childId || wide || route.name !== 'chat') && activePane === 'primary'"
        @open-child="openChild" @close-child="closeChild" @primary-change="primaryChanged" @deleted="sessionDeleted" @navigate="$emit('navigate', $event)" @prepared="$emit('prepared', $event)" />
    </div>
    <div v-if="split" class="conversation-resizer" role="separator" tabindex="0" aria-label="Resize child conversation"
      aria-orientation="vertical" aria-controls="child-conversation-pane" :aria-valuemin="bounds.min" :aria-valuemax="bounds.max" :aria-valuenow="childWidth"
      @pointerdown="startResize" @pointermove="resize" @pointerup="stopResize" @pointercancel="stopResize" @lostpointercapture="stopResize" @keydown="resizeKey" />
    <aside v-if="childId" v-show="route.name === 'chat'" id="child-conversation-pane" class="child-conversation" aria-label="Child conversation"
      @pointerdown.capture="activePane = 'child'" @focusin="activePane = 'child'">
      <ChatTab :key="childId" :api-base="apiBase" :project-id="projectId" :project-name="projectName" embedded :session-id="childId" :visible="visible && route.name === 'chat'" :keyboard-active="keyboardActive && visible && (!wide || activePane === 'child')" @child-navigation="navigateChild">
        <template #pane-actions>
          <button class="close-child" :aria-label="wide ? 'Close child conversation' : 'Back to main conversation'" :title="wide ? 'Close child conversation' : 'Back to main conversation'" @click="closeChild">
            <span class="w-4 h-4" :class="wide ? 'i-lucide-panel-right-close' : 'i-lucide-arrow-left'" aria-hidden="true" />
            <span class="close-child-label">Back to main conversation</span>
          </button>
        </template>
      </ChatTab>
    </aside>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ChatTab from './ChatTab.vue'
import { childConversationTarget, childWidthBounds, clampChildWidth, SPLIT_HANDLE_WIDTH, SPLIT_MIN_WIDTH } from '../conversation-split.ts'
import type { FolderRecord } from '../folders-client.ts'
import type { KnowledgeTabRequest, ProjectTab } from '../file-workbench.ts'

const props = withDefaults(defineProps<{ apiBase: string; projectId?: string; projectName?: string; managed?: boolean; embedded?: boolean; keyboardActive?: boolean; sessionId?: string; initialFolder?: FolderRecord; openRemote?: boolean; visible?: boolean; childSessionId?: string; knowledgeRequest?: KnowledgeTabRequest; automationRun?: boolean }>(), { visible: true, embedded: false, keyboardActive: true })
const emit = defineEmits<{ navigate: [id: string, childId?: string]; prepared: [id: string]; 'knowledge-navigation': [active: boolean, entryId?: string]; 'project-navigation': [tab?: ProjectTab] }>()
const route = useRoute()
const router = useRouter()
const workspace = ref<HTMLElement>()
const primary = ref<InstanceType<typeof ChatTab>>()
const childId = ref('')
const activePane = ref<'primary' | 'child'>('primary')
const workspaceWidth = ref(0)
const preferredWidth = ref(480)
const wide = computed(() => workspaceWidth.value >= SPLIT_MIN_WIDTH)
const split = computed(() => wide.value && !!childId.value && route.name === 'chat')
const bounds = computed(() => childWidthBounds(workspaceWidth.value))
const childWidth = computed(() => clampChildWidth(preferredWidth.value, workspaceWidth.value))
const drag = shallowRef<{ x: number; width: number; target: HTMLElement; pointerId: number }>()
let observer: ResizeObserver | undefined

function primaryChanged() {
  stopResize()
  childId.value = ''
  activePane.value = 'primary'
}
function openChild(target: { primaryId: string; childId: string }) {
  if (props.managed) { emit('navigate', target.primaryId, target.childId); return }
  childId.value = target.childId
  activePane.value = 'child'
  void router.replace({ name: 'chat', params: { projectId: props.projectId, sessionId: target.primaryId }, query: { child: target.childId } })
}
function navigateChild(id: string) {
  if (props.managed) { emit('navigate', props.sessionId ?? '', id); return }
  childId.value = id
  void router.replace({ query: { ...route.query, child: id } })
}
function closeChild() {
  primaryChanged()
  if (props.managed) emit('navigate', props.sessionId ?? '')
  else void router.replace({ query: { ...route.query, child: undefined } })
  void nextTick(() => primary.value?.focusConversation())
}
function sessionDeleted(id: string) {
  if (childId.value === id || childConversationTarget(primary.value?.allSessions ?? [], childId.value, id)?.primaryId === id) closeChild()
}
function startResize(event: PointerEvent) {
  if (event.button !== 0 || !(event.currentTarget instanceof HTMLElement)) return
  event.preventDefault()
  event.currentTarget.setPointerCapture(event.pointerId)
  drag.value = { x: event.clientX, width: childWidth.value, target: event.currentTarget, pointerId: event.pointerId }
}
function resize(event: PointerEvent) {
  if (!drag.value || event.pointerId !== drag.value.pointerId) return
  preferredWidth.value = clampChildWidth(drag.value.width + drag.value.x - event.clientX, workspaceWidth.value)
}
function stopResize() {
  const current = drag.value
  drag.value = undefined
  if (current?.target.hasPointerCapture(current.pointerId)) current.target.releasePointerCapture(current.pointerId)
}
function resizeKey(event: KeyboardEvent) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(event.key)) return
  event.preventDefault()
  if (event.key === 'Escape') { stopResize(); return }
  preferredWidth.value = clampChildWidth(event.key === 'Home' ? bounds.value.min : event.key === 'End' ? bounds.value.max
    : childWidth.value + (event.key === 'ArrowLeft' ? 24 : -24), workspaceWidth.value)
}
function measure() {
  if (workspace.value) workspaceWidth.value = workspace.value.getBoundingClientRect().width
}
function activate() {
  observer?.disconnect()
  observer = new ResizeObserver(measure)
  if (workspace.value) observer.observe(workspace.value)
  measure()
  window.addEventListener('blur', stopResize)
}
function deactivate() {
  stopResize()
  observer?.disconnect()
  window.removeEventListener('blur', stopResize)
}
watch(wide, value => { if (!value) stopResize() })
watch(() => [route.name, route.params.sessionId, route.query.child], () => {
  if (props.managed || route.name !== 'chat') return
  const id = typeof route.params.sessionId === 'string' ? route.params.sessionId : ''
  primary.value?.restoreSession(id)
  const nextChild = typeof route.query.child === 'string' && route.query.child !== id ? route.query.child : ''
  if (nextChild !== childId.value) activePane.value = nextChild ? 'child' : 'primary'
  childId.value = nextChild
  if (!childId.value) activePane.value = 'primary'
}, { immediate: true })
watch(() => props.childSessionId, id => {
  if (!props.managed) return
  childId.value = id && id !== props.sessionId ? id : ''
  activePane.value = childId.value ? 'child' : 'primary'
}, { immediate: true })
defineExpose({
  requestSession: (id: string) => primary.value?.requestSession(id),
  appendDraft: (text: string) => {
    if (childId.value) closeChild()
    primary.value?.appendDraft(text)
  },
  focusConversation: () => primary.value?.focusConversation(),
  quoteSelection: (text: string) => primary.value?.quoteSelection(text),
  handleImageContext: (update: Parameters<InstanceType<typeof ChatTab>['handleImageContext']>[0]) => primary.value?.handleImageContext(update),
  handleImageBusy: (update: Parameters<InstanceType<typeof ChatTab>['handleImageBusy']>[0]) => primary.value?.handleImageBusy(update),
})
onMounted(activate)
onActivated(activate)
onDeactivated(deactivate)
onUnmounted(deactivate)
</script>

<style scoped>
.conversation-workspace { display: grid; grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(0, 1fr); flex: 1; min-width: 0; min-height: 0; height: 100%; }
.primary-conversation, .child-conversation { display: flex; min-width: 0; min-height: 0; overflow: hidden; }
.child-conversation { background: var(--c-bg); }
.conversation-resizer { position: relative; cursor: col-resize; touch-action: none; outline: none; }
.conversation-resizer::after { content: ''; position: absolute; inset: 0 auto 0 3px; width: 1px; background: var(--c-border); }
.conversation-resizer:hover::after, .conversation-resizer:focus-visible::after, .is-resizing .conversation-resizer::after { width: 2px; background: var(--c-blue); }
.is-resizing, .is-resizing :deep(*) { cursor: col-resize !important; user-select: none !important; }
.close-child { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; margin-right: 10px; padding: 0; border: 0; border-radius: var(--radius-control); color: var(--c-text-secondary); background: transparent; cursor: pointer; }
.close-child:hover { background: var(--c-bg-muted); color: var(--c-text); }
.close-child:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.close-child-label { display: none; }
@media (max-width: 700px) { .close-child-label { display: inline; } }
</style>
