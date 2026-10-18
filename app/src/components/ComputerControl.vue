<template>
  <section v-if="enabled && (expanded || error || status?.grant || busy)" class="computer-control" :aria-label="t('Computer use')">
    <div class="computer-toolbar">
      <button type="button" class="computer-disclosure" :aria-expanded="expanded" :aria-controls="panelId" @click="expanded = !expanded">
        <span class="i-lucide-monitor w-3.5 h-3.5" aria-hidden="true" />
        {{ t('Computer use') }}
        <span class="computer-state">{{ stateLabel }}</span>
      </button>
      <button v-if="status?.grant || status?.busy || busy" type="button" class="computer-stop"
        :disabled="operation === 'stopping'" @click="stop">{{ operation === 'stopping' ? t('Stopping…') : t('Stop all desktop access') }}</button>
    </div>
    <div v-if="expanded || error" :id="panelId" class="computer-body">
      <p v-if="error" class="computer-error" role="alert">{{ error }}</p>
      <button v-if="error" type="button" :disabled="loading || busy" @click="refresh">{{ t('Reload status') }}</button>
      <template v-if="expanded">
        <p v-if="!status && loading" role="status">{{ t('Checking desktop availability…') }}</p>
        <p v-else-if="status && !status.available">{{ t('Requires Windows, a local owner connection and Main local execution. Remote desktops and elevated applications are not supported.') }}</p>
        <p v-else-if="status?.busy">{{ t('Another conversation is using the desktop. Stop its access before sharing a window here.') }}</p>
        <template v-else-if="status?.grant">
          <p class="computer-target"><strong>{{ status.grant.target.title || status.grant.target.app }}</strong><span>{{ status.grant.target.app }} · {{ t('Access expires at {time}', { time: formatDateTime(status.grant.expiresAt, { hour: '2-digit', minute: '2-digit' }) }) }}</span></p>
          <p class="computer-note">{{ status.grant.foregroundInput ? t('Keyboard and mouse enabled; UIA remains preferred.') : t('UIA only; keyboard and mouse are off.') }}</p>
          <template v-if="!status.grant.foregroundInput && !status.pending && !status.executing">
            <p class="computer-note">{{ t('Off by default. Each input still needs approval. Shadow attempts to restore focus and pointer position only if you have not taken over.') }}</p>
            <button type="button" :disabled="busy || needsReload" @click="enableForeground">{{ t('Allow foreground keyboard and mouse') }}</button>
          </template>
          <template v-if="status.pending">
            <h3>{{ t('Approve this action once?') }}</h3>
            <dl>
              <dt>{{ t('Action') }}</dt><dd>{{ actionLabel(status.pending.action.kind) }}</dd>
              <template v-if="status.pending.element">
                <dt>{{ t('Control') }}</dt><dd>{{ status.pending.element.name || status.pending.element.role }}</dd>
              </template>
              <template v-if="pointerAction">
                <dt>{{ t('Screenshot position') }}</dt><dd>({{ pointerAction.x }}, {{ pointerAction.y }})</dd>
                <template v-if="pointerAction.kind === 'drag'">
                  <dt>{{ t('Drag destination') }}</dt><dd>({{ pointerAction.toX }}, {{ pointerAction.toY }}) · {{ pointerAction.durationMs }} ms</dd>
                </template>
                <template v-if="pointerAction.kind === 'click'">
                  <dt>{{ t('Mouse button') }}</dt><dd>{{ buttonLabel(pointerAction.button) }} · {{ t('Click count: {count}', { count: pointerAction.count }) }}</dd>
                </template>
                <template v-if="pointerAction.kind === 'wheel'">
                  <dt>{{ t('Wheel direction') }}</dt><dd>{{ directionLabel(pointerAction.axis === 'vertical' ? pointerAction.steps > 0 ? 'down' : 'up' : pointerAction.steps > 0 ? 'right' : 'left') }} · {{ t('{count} wheel steps', { count: Math.abs(pointerAction.steps) }) }}</dd>
                </template>
                <template v-if="'modifiers' in pointerAction && pointerAction.modifiers.length">
                  <dt>{{ t('Held modifiers') }}</dt><dd><kbd>{{ pointerAction.modifiers.join(' + ') }}</kbd></dd>
                </template>
              </template>
              <template v-if="status.pending.action.kind === 'press_key'">
                <dt>{{ t('Keys') }}</dt><dd><kbd>{{ [...status.pending.action.modifiers, status.pending.action.key].join(' + ') }}</kbd></dd>
              </template>
            </dl>
            <template v-if="status.pending.action.kind === 'set_value'">
              <p>{{ t('Replace the entire field with:') }}</p><pre>{{ status.pending.action.value || t('(empty value)') }}</pre>
            </template>
            <template v-if="status.pending.action.kind === 'type_text'">
              <p>{{ t('Insert text at the current selection:') }}</p><pre>{{ status.pending.action.text }}</pre>
            </template>
            <figure v-if="pointerAction && status.pending.frame" class="computer-review-frame">
              <div v-if="frameUrl" class="computer-frame" :style="{ maxWidth: `${status.pending.frame.width}px` }">
                <img :key="frameUrl" :src="frameUrl" :width="status.pending.frame.width" :height="status.pending.frame.height"
                  :alt="t('The exact window screenshot for this action')" draggable="false" referrerpolicy="no-referrer"
                  @load="onFrameLoad" @error="onFrameError">
                <svg v-if="frameState === 'ready'" class="computer-markers"
                  :viewBox="`0 0 ${status.pending.frame.width} ${status.pending.frame.height}`" aria-hidden="true">
                  <g v-for="layer in ['outline', 'inner']" :key="layer" :class="`computer-marker-${layer}`">
                    <line v-if="pointerAction.kind === 'drag'" :x1="pointerAction.x + .5" :y1="pointerAction.y + .5"
                      :x2="pointerAction.toX + .5" :y2="pointerAction.toY + .5" vector-effect="non-scaling-stroke" />
                    <circle :cx="pointerAction.x + .5" :cy="pointerAction.y + .5" :r="markerRadius" vector-effect="non-scaling-stroke" />
                    <rect v-if="pointerAction.kind === 'drag'" :x="pointerAction.toX + .5 - markerRadius" :y="pointerAction.toY + .5 - markerRadius"
                      :width="markerRadius * 2" :height="markerRadius * 2" vector-effect="non-scaling-stroke" />
                  </g>
                </svg>
              </div>
              <p v-if="frameState === 'loading'" role="status">{{ t('Loading the exact review screenshot…') }}</p>
              <template v-if="frameState === 'error'">
                <p class="computer-error" role="alert">{{ t('The review screenshot could not be loaded. Approval is disabled; reload the preview or reject this action.') }}</p>
                <button type="button" :disabled="busy || needsReload || !remaining" @click="reloadFrame">{{ t('Reload preview') }}</button>
              </template>
              <figcaption class="computer-note">{{ t('Coordinates use this screenshot, not desktop pixels. The circle is the start; a square marks the drag destination.') }}</figcaption>
            </figure>
            <p v-if="status.pending.action.kind === 'scroll'">{{ t('Direction: {direction}', { direction: directionLabel(status.pending.action.direction) }) }}</p>
            <p v-if="foregroundPending" class="computer-foreground">{{ t('This briefly activates the window and may move your pointer. Taking over the keyboard or mouse stops further input, but cannot undo input already delivered.') }}</p>
            <p class="computer-note">{{ t('Check the target application before approving. This may submit, delete or send data; Shadow cannot infer every button’s effect.') }}</p>
            <p class="computer-note" role="status">{{ remaining ? t('Review expires in {seconds}s', { seconds: remaining }) : t('Review expired. Ask the assistant to observe again.') }}</p>
            <div class="computer-actions">
              <button type="button" :disabled="busy || needsReload || !remaining" @click="decide(false)">{{ t('Reject action') }}</button>
              <button type="button" class="computer-primary" :disabled="!canApprove" @click="decide(true)">{{ operation === 'approving' ? t('Approving…') : t('Approve once') }}</button>
            </div>
          </template>
          <p v-else-if="status.executing" role="status">{{ t('Executing one approved action…') }}</p>
          <p v-else class="computer-note">{{ t('The assistant can observe this window. Every modification needs your approval.') }}</p>
        </template>
        <template v-else-if="status?.available">
          <p class="computer-note">{{ t('The assistant can list and select a supported window for your requested task; no manual sharing is needed. Access lasts 10 minutes. Window text and requested screenshots go to your configured model. Every modification still needs your approval.') }}</p>
          <p class="computer-note">{{ t('Close sensitive content first. Screenshots may include secrets. Browsers use the existing browser tools; Shadow cannot control itself.') }}</p>
          <button type="button" :disabled="busy" @click="findWindows">{{ operation === 'windows' ? t('Finding windows…') : t('Refresh available windows') }}</button>
          <p v-if="listed && !windows.length" role="status">{{ t('No supported windows found. Open a normal Windows application, then refresh.') }}</p>
          <template v-if="windows.length">
            <label :for="selectId">{{ t('Window to share (optional manual selection)') }}</label>
            <UiSelect :id="selectId" v-model="selected" :disabled="busy">
              <option disabled value="">{{ t('Select a window') }}</option>
              <option v-for="window in windows" :key="window.id" :value="window.id">{{ window.title || window.app }} — {{ window.app }} ({{ window.pid }})</option>
            </UiSelect>
            <label class="computer-permission">
              <input v-model="foregroundInput" type="checkbox" :disabled="busy || !selected" :aria-describedby="`${panelId}-foreground`">
              <span>{{ t('Allow foreground keyboard and mouse') }}</span>
            </label>
            <p :id="`${panelId}-foreground`" class="computer-note">{{ t('Off by default. Each input still needs approval. Shadow attempts to restore focus and pointer position only if you have not taken over.') }}</p>
            <p v-if="foregroundInput" class="computer-note">{{ t('Coordinate reviews temporarily keep one screenshot in memory until the observation or approval expires, never in chat history or image files.') }}</p>
            <button type="button" class="computer-primary" :disabled="busy || needsReload || !selected" @click="share">{{ operation === 'sharing' ? t('Sharing…') : t('Share this window') }}</button>
          </template>
        </template>
        <p v-if="status?.lastAction?.outcome === 'outcome_unknown'" class="computer-error" role="alert">{{ t('The last action may have taken effect. Access was stopped. Inspect the application before sharing again; the action was not replayed.') }}</p>
        <p v-else-if="status?.lastAction?.outcome === 'executed' && status.lastAction.focusRestored !== undefined && status.lastAction.focusRestored !== true" class="computer-note" role="status">{{ t('Input was delivered, but focus was not restored. Check the application before continuing.') }}</p>
      </template>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId } from 'vue'
import { formatDateTime, t } from '../i18n.ts'
import { useComputer } from '../computer-use.ts'
import UiSelect from './UiSelect.vue'
import { isForegroundAction, isPointerAction, type ComputerAction } from '../../../src/execution/computer/contracts.ts'

const props = defineProps<{ apiBase: string; projectId: string; sessionId: string; active: boolean; canSubmit: boolean; stage?: string | null }>()
const panelId = `computer-${useId()}`
const selectId = `${panelId}-window`
const visible = ref(typeof document === 'undefined' || document.visibilityState !== 'hidden')
const { status, windows, selected, foregroundInput, expanded, error, loading, needsReload, listed, operation, busy, enabled, remaining,
  frameUrl, frameState, canApprove, frameLoaded, frameFailed, reloadFrame,
  refresh, findWindows, share, enableForeground, decide, stop } = useComputer(() => ({ ...props, active: props.active && visible.value }))
const pointerAction = computed(() => {
  const action = status.value?.pending?.action
  return action && isPointerAction(action) ? action : null
})
const foregroundPending = computed(() => !!status.value?.pending && isForegroundAction(status.value.pending.action))
const markerRadius = computed(() => Math.max(6, (status.value?.pending?.frame?.width ?? 0) / 55))
const stateLabel = computed(() => status.value?.pending ? t('Approval needed') : status.value?.grant ? t('Window shared')
  : status.value?.busy ? t('In use elsewhere') : status.value && !status.value.available ? t('Unavailable') : status.value?.available ? t('Ready — assistant can select a window') : loading.value ? t('Checking availability…') : t('Not shared'))
// Opening never enumerates, shares or captures a window.
defineExpose({ open: () => { expanded.value = true }, stateLabel })
function actionLabel(kind: ComputerAction['kind']) {
  return { invoke: t('Activate control'), set_value: t('Replace field value'), toggle: t('Toggle control'), select: t('Select item'), scroll: t('Scroll control'),
    click: t('Click screenshot position'), move: t('Move pointer'), drag: t('Drag with left mouse button'), wheel: t('Scroll with mouse wheel'),
    press_key: t('Press keys'), type_text: t('Type text') }[kind]
}
function buttonLabel(button: 'left' | 'right' | 'middle') {
  return { left: t('Left mouse button'), right: t('Right mouse button'), middle: t('Middle mouse button') }[button]
}
function onFrameLoad(event: Event) {
  if (event.target instanceof HTMLImageElement) frameLoaded(event.target.src, event.target.naturalWidth, event.target.naturalHeight)
}
function onFrameError(event: Event) {
  if (event.target instanceof HTMLImageElement) frameFailed(event.target.src)
}
function directionLabel(direction: 'up' | 'down' | 'left' | 'right') {
  return { up: t('Up'), down: t('Down'), left: t('Left'), right: t('Right') }[direction]
}
function visibility() { visible.value = document.visibilityState !== 'hidden' }
onMounted(() => document.addEventListener('visibilitychange', visibility))
onUnmounted(() => document.removeEventListener('visibilitychange', visibility))
</script>

<style scoped>
.computer-control { box-sizing: border-box; flex: 0 1 auto; min-height: 0; width: calc(100% - 40px); max-width: 860px; margin: 8px auto 0; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); color: var(--c-text); font-size: 13px; line-height: 1.5; overflow: auto; max-height: 42dvh; overscroll-behavior: contain; }
.computer-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 6px 10px; position: sticky; top: 0; background: var(--c-bg-card); z-index: 1; }
.computer-disclosure { display: flex; align-items: center; gap: 8px; border: 0; text-align: start; }
.computer-state, .computer-note, .computer-target span { color: var(--c-text-secondary); font-size: 12px; }
.computer-state { margin-inline-start: 4px; }
.computer-stop { margin-inline-start: auto; color: var(--c-error); }
.computer-body { padding: 0 14px 14px; overflow-wrap: anywhere; }
.computer-target { display: grid; gap: 2px; }
.computer-permission { display: flex; align-items: start; gap: 8px; }
.computer-permission input { width: 16px; height: 16px; margin: 2px 0 0; flex: 0 0 auto; accent-color: var(--c-primary-bg); }
.computer-review-frame { margin: 12px 0; }
.computer-frame { position: relative; width: 100%; }
.computer-frame img { display: block; width: 100%; height: auto; }
.computer-markers { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: hidden; }
.computer-marker-outline { fill: none; stroke: #000; stroke-width: 4px; }
.computer-marker-inner { fill: none; stroke: #fff; stroke-width: 2px; }
figcaption { margin-top: 6px; }
kbd { font: inherit; padding: 1px 4px; background: var(--c-bg-muted); border: 1px solid var(--c-border); border-radius: var(--radius-control); }
p { margin: 8px 0; }
h3 { font-size: 14px; margin: 14px 0 8px; }
dl { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 4px 12px; margin: 8px 0; }
dt { color: var(--c-text-secondary); }
dd { margin: 0; }
pre { max-height: 16dvh; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; padding: 8px; margin: 8px 0; background: var(--c-bg-muted); font: inherit; }
label { display: block; margin: 12px 0 4px; }
.ui-select { display: flex; box-sizing: border-box; width: 100%; min-height: 36px; margin-bottom: 10px; padding: 6px; background: var(--c-bg); color: var(--c-text); border: 1px solid var(--c-control-border); border-radius: var(--radius-control); font: inherit; }
button { min-height: 34px; padding: 6px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text); font: inherit; cursor: pointer; }
button:hover:not(:disabled) { background: var(--c-bg-muted); }
button:disabled { opacity: .5; cursor: not-allowed; }
.computer-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
.computer-primary { background: var(--c-primary-bg); color: var(--c-text-on-primary); }
.computer-primary:hover:not(:disabled) { background: var(--c-primary-bg-hover); }
.computer-error { color: var(--c-error); }
button:focus-visible, input:focus-visible, .ui-select:has(:focus-visible) { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 600px) { .computer-control { width: calc(100% - 24px); } .computer-body { padding: 0 12px 12px; } }
</style>
