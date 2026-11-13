<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import { VueFlow, Handle, Position, useVueFlow } from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import { t } from '../i18n.ts'
import { workflowStatus } from '../workflows.ts'
import { workflowCanvas, type WorkflowCanvasEntry } from '../workflow-canvas.ts'
const props = defineProps<{ flows: WorkflowCanvasEntry[]; selectedId?: string }>()
const emit = defineEmits<{ inspect: [id: string, nodeId?: string]; clear: [] }>()
const id = useId()
const { fitView, zoomIn, zoomOut, setViewport, viewport } = useVueFlow(id)
const pane = ref<HTMLElement>()
const editable = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable="true"]')
function focusCanvas() { pane.value?.focus({ preventScroll: true }) }
defineExpose({ focusCanvas })
function keydown(event: KeyboardEvent) {
  if (editable(event.target) || event.ctrlKey || event.metaKey || event.altKey) return
  if (event.shiftKey && (event.code === 'Digit1' || event.key === '!')) void fitView({ padding: .1 })
  else if (event.shiftKey && (event.code === 'Digit2' || event.key === '@') && props.selectedId) void fitView({ nodes: [JSON.stringify([props.selectedId, 'group'])], padding: .15 })
  else if (event.key === 'Escape') emit('clear')
  else return
  event.preventDefault(); event.stopPropagation()
}
function wheel(event: WheelEvent) {
  if (!pane.value?.contains(document.activeElement) || editable(event.target)) return
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
const canvas = computed(() => workflowCanvas(props.flows))
</script>
<template>
  <section class="workflow-graph" :aria-label="t('Read-only workflow graph')">
    <div class="graph-toolbar">
      <button class="btn btn-sm" @click="zoomIn()">{{ t('Zoom in') }}</button>
      <button class="btn btn-sm" @click="zoomOut()">{{ t('Zoom out') }}</button>
      <button class="btn btn-sm" @click="fitView({ padding: .1 })">{{ t('Fit diagram') }}</button>
      <details class="canvas-help"><summary>{{ t('Canvas shortcuts') }}</summary><p>{{ t('Drag empty canvas with the left or middle mouse button to pan; click a node or workflow title to inspect it. Focus the canvas: scroll to pan; Ctrl/Cmd + scroll to zoom. Shift+1 fits all workflows; Shift+2 fits the selected workflow. Escape clears selection. These shortcuts never edit or run a workflow.') }}</p></details>
    </div>
    <div ref="pane" class="graph-canvas" tabindex="0" :aria-label="t('Workflow canvas')" @keydown="keydown" @wheel="wheel"
      @pointerdown="event => { if (!editable(event.target) && !(event.target as HTMLElement).closest('button')) focusCanvas() }">
      <VueFlow :id="id" :nodes="canvas.nodes" :edges="canvas.edges" :nodes-draggable="false" :nodes-connectable="false"
        :elements-selectable="false" :delete-key-code="null" :connect-on-click="false" :default-viewport="{ x: 20, y: 20, zoom: 1 }"
        :min-zoom=".1" :max-zoom="1.5" :zoom-on-scroll="false" :zoom-on-pinch="false" :pan-on-scroll="false" :prevent-scrolling="false" :zoom-on-double-click="false"
        :pan-on-drag="[0, 1]" :pan-activation-key-code="null" :zoom-activation-key-code="null" :selection-key-code="null" :multi-selection-key-code="null">
        <template #node-group="{ data }">
          <div class="graph-group" :class="{ selected: selectedId === data.definition.id }" :data-workflow="data.definition.id" :data-enabled="data.enabled">
            <button class="group-heading nodrag nopan" @click="inspect(data.definition.id)">
              <strong><span :class="data.enabled ? 'i-lucide-circle-check' : 'i-lucide-circle-pause'" aria-hidden="true" /> {{ data.definition.name || data.definition.id }}</strong>
              <span>{{ data.enabled ? t('Enabled') : t('Paused') }} · {{ t('Revision {revision}', { revision: data.definition.revision }) }}<template v-if="data.run"> · {{ workflowStatus(data.run.status) }}</template><template v-if="data.snapshot"> · {{ t('Run snapshot') }}</template></span>
            </button>
          </div>
        </template>
        <template #node-workflow="{ data }">
          <Handle type="target" :position="Position.Left" :connectable="false" />
          <button class="graph-node nodrag nopan" :data-state="data.status" :data-flow="data.flowId" :data-enabled="data.enabled" @click="inspect(data.flowId, data.id)"><strong>{{ data.label }}</strong><small>{{ data.detail }}</small><small v-if="data.description" class="node-description">{{ data.description }}</small><span :data-state="data.status">{{ workflowStatus(data.status) }}</span></button>
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
.graph-canvas:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.graph-toolbar span { color: var(--c-text-secondary); font-size: 12px; }
.graph-canvas { flex: 1; min-height: 0; width: 100%; position: relative; overflow: hidden; }
/* Keep the shared body dot grid visible, just like the conversation canvas. */
.graph-group { box-sizing: border-box; width: 100%; height: 100%; border: 1px solid var(--c-border); background: transparent; }
.graph-group[data-enabled=true] { border: 2px solid var(--c-border-hover); }
.graph-group[data-enabled=false] { border: 2px dashed var(--c-border); }
.graph-node[data-enabled=false] { border-style: dashed; background: var(--c-bg-soft); }
.group-heading strong span { display: inline-block; width: 16px; height: 16px; vertical-align: middle; }
.graph-group.selected { border-color: var(--c-selection-border); }
.group-heading { display: flex; flex-direction: column; gap: 6px; padding: 14px 24px; text-align: start; background: transparent; border: 0; color: var(--c-text); cursor: pointer; font: inherit; max-width: 100%; }
.group-heading strong { max-width: 760px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.group-heading span { color: var(--c-text-secondary); font-size: 12px; }
.graph-node { box-sizing: border-box; width: 240px; height: 120px; padding: 12px; text-align: start; font: inherit; background: var(--c-bg-card); border: 1px solid var(--c-border); color: var(--c-text); display: flex; flex-direction: column; gap: 4px; cursor: pointer; }
.graph-node strong, .graph-node .node-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }.graph-node small { color: var(--c-text-secondary); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; line-height: 15px; }.graph-node span { font-size: 12px; color: var(--c-text-secondary); }
.graph-node:hover, .group-heading:hover { background: var(--c-bg-muted); }
.graph-node span[data-state=completed] { color: var(--c-success); }.graph-node span[data-state=blocked] { color: var(--c-warn); }.graph-node span[data-state=retry] { color: var(--c-error); }.graph-node span[data-state=running] { color: var(--c-info); }
:deep(.vue-flow__handle) { opacity: 0; pointer-events: none; }
:deep(.vue-flow__node-group) { padding: 0; border: 0; border-radius: 0; background: transparent; text-align: start; }
@media (prefers-reduced-motion: reduce) { :deep(.vue-flow__edge.animated path) { animation: none; } }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
</style>
