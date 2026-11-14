<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { VueFlow, Handle, Position, useVueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { t } from '../i18n.ts'
import { useRouter } from 'vue-router'
import HoverInfo from './HoverInfo.vue'
import { workflowStatus, workflowConversationLocation } from '../workflows.ts'
import { createWorkflowCanvas, type WorkflowCanvasEntry } from '../workflow-canvas.ts'
const router = useRouter()
const props = defineProps<{ flows: WorkflowCanvasEntry[]; selectedId?: string; projectId: string }>()
const emit = defineEmits<{ inspect: [id: string, nodeId?: string]; clear: []; toggle: [id: string, enabled: boolean] }>()
const id = useId()
const { fitView, zoomIn, zoomOut, setViewport, viewport } = useVueFlow(id)
const pane = ref<HTMLElement>(), controls = ref<HTMLElement>()
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]')
function focusCanvas() { pane.value?.focus({ preventScroll: true }) }
defineExpose({ focusCanvas: () => controls.value?.querySelector('button')?.focus({ preventScroll: true }) })
function keydown(event: KeyboardEvent) {
  if (editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.shiftKey && (event.code === 'Digit1' || event.key === '!')) void fitView({ padding: .1 })
  else if (event.shiftKey && (event.code === 'Digit2' || event.key === '@') && props.selectedId) void fitView({ nodes: [JSON.stringify([props.selectedId, 'group'])], padding: .15 })
  else if (event.key === 'Escape') emit('clear')
  else return
  event.preventDefault(); event.stopPropagation()
}
function wheel(event: WheelEvent) {
  if (!pane.value?.parentElement?.contains(document.activeElement) || editable(event.target)) return
  event.preventDefault(); event.stopPropagation()
  const box = pane.value.getBoundingClientRect(), current = viewport.value
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? box.height : 1
  if (event.ctrlKey || event.metaKey) {
    const zoom = Math.max(.1, Math.min(1.5, current.zoom * Math.exp(-event.deltaY * unit * .002)))
    const x = event.clientX - box.left, y = event.clientY - box.top, ratio = zoom / current.zoom
    void setViewport({ x: x - (x - current.x) * ratio, y: y - (y - current.y) * ratio, zoom })
  } else void setViewport({ ...current, x: current.x - (event.shiftKey ? event.deltaY : event.deltaX) * unit, y: current.y - (event.shiftKey ? 0 : event.deltaY) * unit })
}
function inspect(flow: string, node?: string) { emit('inspect', flow, node) }
const buildCanvas = createWorkflowCanvas()
const canvas = computed(() => buildCanvas(props.flows))
</script>
<template>
  <section class="workflow-graph" :aria-label="t('Read-only workflow graph')" @keydown="keydown">
    <div ref="controls" class="graph-toolbar">
      <button class="btn btn-sm" @click="zoomIn()">{{ t('Zoom in') }}</button>
      <button class="btn btn-sm" @click="zoomOut()">{{ t('Zoom out') }}</button>
      <button class="btn btn-sm" @click="fitView({ padding: .1 })">{{ t('Fit diagram') }}</button>
      <details class="canvas-help"><summary>{{ t('Canvas shortcuts') }}</summary><p>{{ t('Drag empty canvas with the left or middle mouse button to pan; click a node or workflow title to inspect it. Focus the canvas: scroll to pan; Ctrl/Cmd + scroll to zoom. Shift+1 fits all workflows; Shift+2 fits the selected workflow. Escape clears selection. These shortcuts never edit or run a workflow.') }}</p></details>
    </div>
    <div ref="pane" class="graph-canvas" tabindex="-1" :aria-label="t('Workflow canvas')" @wheel="wheel"
      @pointerdown="event => { if (!editable(event.target) && !(event.target as HTMLElement).closest('button')) focusCanvas() }">
      <VueFlow :id="id" :nodes="canvas.nodes" :edges="canvas.edges" :nodes-draggable="false" :nodes-connectable="false"
        :elements-selectable="false" :delete-key-code="null" :connect-on-click="false" :default-viewport="{ x: 20, y: 20, zoom: 1 }"
        :min-zoom=".1" :max-zoom="1.5" :zoom-on-scroll="false" :zoom-on-pinch="false" :pan-on-scroll="false" :prevent-scrolling="false" :zoom-on-double-click="false"
        :pan-on-drag="[0, 1]" :pan-activation-key-code="null" :zoom-activation-key-code="null" :selection-key-code="null" :multi-selection-key-code="null">
        <template #node-column="{ data }">
          <h2 class="graph-column-heading" :data-column="data.column">{{ data.column === 'cron' ? t('Cron workflows') : data.column === 'automation' ? t('Automation workflows') : t('BOT workflows') }}</h2>
        </template>
        <template #node-group="{ data }">
          <div class="graph-group" :class="{ selected: selectedId === data.definition.id }" :data-workflow="data.definition.id" :data-column="data.column" :data-enabled="data.enabled" :data-projection="data.projection || undefined">
            <div class="group-header">
            <button class="group-heading nodrag nopan" @click="inspect(data.definition.id)">
              <strong><span :class="data.projection ? (data.projectionType === 'connection' ? 'i-lucide-plug' : data.projectionType === 'deployment' ? 'i-lucide-package' : 'i-lucide-git-branch') : data.enabled ? 'i-lucide-circle-check' : 'i-lucide-circle-pause'" aria-hidden="true" /> {{ data.definition.name || data.definition.id }}</strong>
              <span :class="{ 'projection-type': data.projection }">{{ data.projection ? (data.projectionType === 'connection' ? (data.sinkProjection ? t('Connection') : t('BOT connection')) : data.projectionType === 'deployment' ? t('Published BOT / Agent') : t('Conversation binding')) : data.enabled ? t('Enabled') : t('Paused') }}<template v-if="data.run"> · {{ workflowStatus(data.run.status) }}</template><template v-if="data.snapshot"> · {{ t('This run configuration') }}</template></span>
            </button>
            <div class="group-actions nodrag nopan" @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop @click.stop>
            <button v-if="data.control" class="btn btn-sm group-toggle" :disabled="data.control.disabled" :aria-busy="data.control.busy"
              :aria-label="t('{action} workflow {name}', { action: data.control.enabled ? t('Pause') : t('Resume'), name: data.definition.name || data.definition.id })"
              @click="emit('toggle', data.definition.id, !data.control.enabled)">
              {{ data.control.busy ? t('Saving…') : data.control.enabled ? t('Pause') : t('Resume') }}
            </button>
            <HoverInfo v-if="data.sinkProjection" :text="t('Open connection content')">
              <template #default="{ triggerProps }"><button v-bind="triggerProps" class="btn btn-sm group-conversation nodrag nopan" @click.stop="inspect(data.definition.id)">{{ t('Open connection content') }}</button></template>
            </HoverInfo>
            <HoverInfo v-else-if="data.configureConnectionId" :text="t('Configure BOT connection')">
              <template #default="{ triggerProps }">
                <RouterLink v-bind="triggerProps" class="btn btn-sm group-connection nodrag nopan" :aria-label="t('Configure BOT connection')"
                  :to="{ name: 'project-settings', params: { projectId, section: 'connections' }, query: { connectionId: data.configureConnectionId } }">
                  <span class="i-lucide-ellipsis" aria-hidden="true" />
                </RouterLink>
              </template>
            </HoverInfo>
            <HoverInfo v-else :text="data.conversation ? (data.conversation.kind === 'automation' ? t('Open the latest automation run and its conversation history.') : data.conversation.kind === 'latest' ? t('Open the most recent retained run with a recorded session.') : t('Open the configured target session.')) : t('No associated session recorded. This does not start a workflow or conversation.')">
              <template #default="{ triggerProps }">
                <button v-bind="triggerProps" class="btn btn-sm group-conversation nodrag nopan" :aria-disabled="!data.conversation"
                  @pointerdown.stop @mousedown.stop @dblclick.stop @keydown.stop
                  @click.stop="data.conversation && router.push(workflowConversationLocation(projectId, data.conversation))">
                  {{ data.conversation && data.conversation.kind !== 'fixed' ? t('Open latest conversation') : t('Open conversation') }}
                </button>
              </template>
            </HoverInfo>
            </div>
            </div>
            <p v-if="data.control?.error" class="group-feedback failure" role="alert">{{ data.control.error }}</p>
            <p v-else-if="data.control?.notice" class="group-feedback" role="status">{{ data.control.notice }}</p>
          </div>
        </template>
        <template #node-workflow="{ data }">
          <Handle type="target" :position="Position.Left" :connectable="false" />
          <div class="graph-node-shell" :class="{ 'has-target': data.targetSessionId }"><button class="graph-node nodrag nopan" :data-node-type="data.nodeType" :data-state="data.status" :data-flow="data.flowId" :data-enabled="data.enabled" @click="inspect(data.flowId, data.id)"><strong>{{ data.label }}</strong><small>{{ data.detail }}</small><small v-if="data.description" class="node-description">{{ data.description }}</small><span v-if="!data.projection" :data-state="data.status">{{ workflowStatus(data.status) }}</span></button>
            <RouterLink v-if="data.targetSessionId" class="node-session-link nodrag nopan" :to="{ name: 'chat', params: { projectId, sessionId: data.targetSessionId } }" @pointerdown.stop @mousedown.stop @click.stop @keydown.stop>{{ t('Target session') }}: {{ data.targetSessionId }}</RouterLink>
          </div>
          <Handle type="source" :position="Position.Right" :connectable="false" />
        </template>
      </VueFlow>
    </div>
  </section>
</template>
<style scoped>
.workflow-graph { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
.graph-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 20px; border-bottom: 1px solid var(--c-border); }
.canvas-help { position: relative; color: var(--c-text-secondary); font-size: 12px; }.canvas-help summary { padding: 8px; cursor: pointer; }.canvas-help p { position: absolute; top: 100%; right: 0; width: min(340px, 75vw); margin: 0; padding: 12px; background: var(--c-bg-card); border: 1px solid var(--c-border); z-index: 10; line-height: 1.6; }
/* Pointer focus scopes wheel handling; keyboard entry is through the visible toolbar. */
.graph-canvas:focus { outline: none; }
.graph-toolbar span { color: var(--c-text-secondary); font-size: 12px; }
.graph-canvas { flex: 1; min-height: 0; width: 100%; position: relative; overflow: hidden; }
/* Keep the shared body dot grid visible, just like the conversation canvas. */
.graph-column-heading { margin: 0; padding: 0 0 10px; border-bottom: 1px solid var(--c-border); color: var(--c-text-secondary); font-size: 14px; line-height: 20px; font-weight: 600; }
.graph-group { box-sizing: border-box; width: 100%; height: 100%; border: 1px solid var(--c-border); background: transparent; }
.graph-group[data-enabled=true] { border: 2px solid var(--c-border-hover); }
.graph-group[data-enabled=false] { border: 2px dashed var(--c-border); }
.graph-node[data-enabled=false] { border-style: dashed; background: color-mix(in srgb, var(--node-tint, var(--c-bg-card)) 45%, var(--c-bg-soft)); }
.graph-group[data-projection=true] { border: 1px solid var(--c-border); }
.group-heading strong span { display: inline-block; width: 16px; height: 16px; vertical-align: middle; }
.graph-group.selected { border-color: var(--c-selection-border); }
.group-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.group-actions { display: flex; flex-shrink: 0; align-items: center; gap: 6px; margin: 10px 12px 0 0; }
.group-actions button { white-space: nowrap; }
.group-connection { display: inline-flex; align-items: center; justify-content: center; min-width: 32px; min-height: 32px; text-decoration: none; }
.group-connection span { display: block; width: 16px; height: 16px; }
.group-connection:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.group-feedback { position: absolute; top: 184px; left: 24px; right: 12px; margin: 0; font-size: 11px; color: var(--c-text-secondary); line-height: 14px; }
.group-feedback.failure { color: var(--c-error); }
.group-conversation[aria-disabled=true] { color: var(--c-text-muted); cursor: not-allowed; }
.group-heading { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 6px; padding: 14px 24px; text-align: start; background: transparent; border: 0; color: var(--c-text); cursor: pointer; font: inherit; max-width: 100%; }
.group-heading .projection-type { box-sizing: border-box; width: max-content; max-width: 240px; flex-shrink: 0; align-self: flex-start; padding: 1px 4px; background: var(--c-bg-soft); border: 1px solid var(--c-border); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-heading strong { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.group-heading span { color: var(--c-text-secondary); font-size: 12px; }
.graph-node-shell { position: relative; width: 240px; height: 120px; }.has-target .graph-node { padding-bottom: 28px; }.node-session-link { position: absolute; bottom: 5px; left: 12px; right: 12px; font-size: 12px; color: var(--c-primary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }.node-session-link:focus-visible { outline: 2px solid var(--c-blue); }
.graph-node { box-sizing: border-box; width: 240px; height: 120px; padding: 12px; text-align: start; font: inherit; background: var(--node-tint, var(--c-bg-card)); border: 1px solid var(--c-border-hover); color: var(--c-text); display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
.graph-node strong, .graph-node .node-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }.graph-node small { color: var(--c-text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 15px; }.graph-node span { font-size: 12px; color: var(--c-text-secondary); }
.graph-node:hover { background: color-mix(in srgb, var(--node-tint, var(--c-bg-card)) 75%, var(--c-bg-muted)); }
.group-heading:hover { background: var(--c-bg-muted); }
.graph-node span[data-state] { align-self: flex-start; background: var(--c-bg-card); padding: 1px 4px; }
.graph-node[data-node-type=connection] { --node-tint: var(--c-graph-connection-bg); }
.graph-node[data-node-type=binding] { --node-tint: var(--c-graph-binding-bg); }
.graph-node[data-node-type=deployment] { --node-tint: var(--c-graph-deployment-bg); }
.graph-node[data-node-type=session] { --node-tint: var(--c-graph-session-bg); }
.graph-node[data-node-type=source] { --node-tint: var(--c-graph-source-bg); }
.graph-node[data-node-type=gate] { --node-tint: var(--c-graph-gate-bg); }
.graph-node[data-node-type=action] { --node-tint: var(--c-graph-action-bg); }
.graph-node span[data-state=completed] { color: var(--c-success); }.graph-node span[data-state=blocked] { color: var(--c-warn); }.graph-node span[data-state=retry] { color: var(--c-error); }.graph-node span[data-state=running] { color: var(--c-info); }
:deep(.vue-flow__handle) { opacity: 0; pointer-events: none; }
:deep(.vue-flow__node-group) { padding: 0; border: 0; border-radius: 0; background: transparent; text-align: start; }
@media (prefers-reduced-motion: reduce) { :deep(.vue-flow__edge.animated path) { animation: none; } }
@media (max-width: 700px), (pointer: coarse) { .group-conversation { min-height: 44px; margin-top: 6px; } .group-connection { min-width: 44px; min-height: 44px; } }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
