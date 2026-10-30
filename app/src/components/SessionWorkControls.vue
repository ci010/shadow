<template>
  <section v-show="backgroundStatus.total || backgroundStatus.error || scheduledStatus.total || scheduledStatus.error || subagents?.length || expanded" ref="root" class="session-work-controls" :aria-label="t('Session controls')" @keydown.esc="closePanel">
    <div class="session-work-triggers">
      <button v-if="backgroundStatus.total || backgroundStatus.error || expanded === 'background'" :id="`${id}-background`" ref="backgroundTrigger"
        type="button" data-session-work="background" :aria-expanded="expanded === 'background'" :aria-controls="`${id}-panel`"
        aria-haspopup="dialog" @click="toggle('background')">
        <span class="i-lucide-terminal work-icon" aria-hidden="true" />
        <span>{{ t('Background tasks') }}</span>
        <span v-if="backgroundStatus.error" class="session-work-attention" :aria-label="t('Status unavailable')">!</span>
        <span v-else>{{ backgroundStatus.total }}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 9 3-3 3 3" /></svg>
      </button>
      <button v-if="scheduledStatus.total || scheduledStatus.error || expanded === 'scheduled'" :id="`${id}-scheduled`" ref="scheduledTrigger"
        type="button" data-session-work="scheduled" :aria-expanded="expanded === 'scheduled'" :aria-controls="`${id}-panel`"
        aria-haspopup="dialog" @click="toggle('scheduled')">
        <span class="i-lucide-alarm-clock work-icon" aria-hidden="true" />
        <span>{{ t('Scheduled tasks') }}</span><span>{{ scheduledStatus.error ? '!' : scheduledStatus.total }}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 9 3-3 3 3" /></svg>
      </button>
      <button v-if="subagents?.length || expanded === 'subagents'" :id="`${id}-subagents`" ref="subagentsTrigger"
        type="button" :class="{ 'work-chip-active': subagentStatus.running > 0 }" data-session-work="subagents" :aria-expanded="expanded === 'subagents'" :aria-controls="`${id}-panel`"
        aria-haspopup="dialog" :title="subagentActivityLabel(subagentStatus)" @click="toggle('subagents')">
        <span class="i-lucide-git-branch work-icon" aria-hidden="true" />
        <span>{{ t('Subagents') }}</span><span>{{ subagents?.length ?? 0 }}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 9 3-3 3 3" /></svg>
      </button>
    </div>
    <Teleport to="body">
      <OverlayTransition @after-leave="shownPanel = null">
      <div v-show="expanded" :id="`${id}-panel`" ref="popup" class="session-work-panel" :class="{ 'subagent-panel': shownPanel === 'subagents', 'work-chip-active work-popup-active': shownPanel === 'subagents' && subagentStatus.running > 0 }" role="dialog" tabindex="-1"
        :aria-labelledby="`${id}-${shownPanel || 'background'}`" :style="position" @keydown="popupKeydown">
        <div v-show="shownPanel === 'background'">
          <BackgroundTasks :api-base="apiBase" :session-id="sessionId" :active="active !== false" embedded @status="backgroundStatus = $event" />
        </div>
        <div v-show="shownPanel === 'scheduled'">
          <ScheduledTasks :api-base="apiBase" :session-id="sessionId" :active="active !== false" @status="scheduledStatus = $event" />
        </div>
        <div v-show="shownPanel === 'subagents'" class="subagent-list" :aria-label="t('Active subagents')">
          <p v-if="!subagents?.length">{{ t('No subagents active.') }}</p>
          <button v-for="agent in subagents" :key="agent.sessionId" type="button" class="subagent-inspect"
            :data-subagent-id="agent.sessionId" :aria-label="t('Inspect subagent: {label}', { label: agent.label })" @click="inspect(agent.sessionId)">
            <span class="i-lucide-git-branch work-icon" aria-hidden="true" />
            <span class="subagent-copy"><strong>{{ agent.label }}</strong><span>{{ agent.mode === 'call' ? t('Blocking call') : t('Background task') }}<template v-if="agent.agentType"> · {{ agent.agentType }}</template></span></span>
            <SessionActivity :stage="executionDisplayStage(agent, stages?.[agent.sessionId])" />
          </button>
        </div>
      </div>
      </OverlayTransition>
    </Teleport>
  </section>
</template>

<script setup lang="ts">
import { isSelectPopupEventInside } from '../select-control.ts'
import { t } from '../i18n.ts'
import { computed, nextTick, onDeactivated, ref, useId, watch } from 'vue'
import ScheduledTasks from './ScheduledTasks.vue'
import BackgroundTasks from './BackgroundTasks.vue'
import SessionActivity from './SessionActivity.vue'
import OverlayTransition from './OverlayTransition.vue'
import type { SidebarSession } from '../folders-sidebar.ts'
import { executionDisplayStage, subagentActivityLabel, summarizeSubagents } from '../subagent-executions.ts'

const props = defineProps<{ apiBase: string; sessionId: string; canWrite: boolean; active?: boolean; subagents?: SidebarSession[]; stages?: Record<string, string> }>()
const emit = defineEmits<{ inspect: [sessionId: string] }>()
const id = useId()
type Panel = 'background' | 'subagents' | 'scheduled'
const expanded = ref<Panel | null>(null)
const shownPanel = ref<Panel | null>(null)
const scheduledStatus = ref({ total: 0, error: '' })
const scheduledTrigger = ref<HTMLButtonElement>()
const backgroundStatus = ref({ total: 0, loading: false, error: '' })
const subagentStatus = computed(() => summarizeSubagents(props.subagents ?? [], props.stages ?? {}))
const backgroundTrigger = ref<HTMLButtonElement>()
const subagentsTrigger = ref<HTMLButtonElement>()
const root = ref<HTMLElement>()
const popup = ref<HTMLElement>()
const position = ref<Record<string, string>>({})

function trigger(panel: Panel) {
  return ({ background: backgroundTrigger, subagents: subagentsTrigger, scheduled: scheduledTrigger })[panel].value
}
function toggle(panel: Panel) {
  if (props.active === false) return
  expanded.value = expanded.value === panel ? null : panel
}
function closePanel(event: KeyboardEvent) {
  if (!expanded.value || event.defaultPrevented) return
  event.preventDefault()
  event.stopPropagation()
  const anchor = trigger(expanded.value)
  expanded.value = null
  void nextTick(() => (anchor?.isConnected ? anchor : backgroundTrigger.value ?? subagentsTrigger.value
    ?? root.value?.closest('.conversation-dock')?.querySelector<HTMLTextAreaElement>('.composer-input textarea'))?.focus())
}
function inspect(sessionId: string) {
  expanded.value = null
  emit('inspect', sessionId)
}
function popupKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') { closePanel(event); return }
  if (event.key !== 'Tab') return
  const controls = [...popup.value?.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), textarea:not(:disabled), input:not(:disabled), summary, a[href], [tabindex="0"]') ?? []]
    .filter(element => element.getClientRects().length)
  const edge = event.shiftKey ? controls[0] : controls.at(-1)
  if (!controls.length || document.activeElement === edge || (event.shiftKey && document.activeElement === popup.value)) closePanel(event)
}
watch(expanded, async (panel, _previous, onCleanup) => {
  if (!panel) return
  shownPanel.value = panel
  const anchor = trigger(panel)
  if (!anchor) return
  const viewport = window.visualViewport
  const place = () => {
    const rect = anchor.getBoundingClientRect()
    const left = viewport?.offsetLeft ?? 0
    const top = viewport?.offsetTop ?? 0
    const width = Math.min(520, (viewport?.width ?? window.innerWidth) - 24)
    position.value = {
      width: `${width}px`,
      left: `${Math.max(left + 12, Math.min(rect.left, left + (viewport?.width ?? window.innerWidth) - width - 12))}px`,
      bottom: `${window.innerHeight - rect.top + 8}px`,
      maxHeight: `${Math.max(0, Math.min(420, rect.top - top - 20))}px`,
    }
  }
  const dismissOutside = (event: Event) => {
    if (popup.value && isSelectPopupEventInside(event, popup.value)) return
    if (event.target instanceof Node && !root.value?.contains(event.target) && !popup.value?.contains(event.target)) expanded.value = null
  }
  const observer = new ResizeObserver(place)
  if (root.value) observer.observe(root.value)
  if (root.value?.parentElement) observer.observe(root.value.parentElement)
  window.addEventListener('resize', place)
  window.addEventListener('scroll', place, true)
  viewport?.addEventListener('resize', place)
  viewport?.addEventListener('scroll', place)
  document.addEventListener('pointerdown', dismissOutside, true)
  document.addEventListener('focusin', dismissOutside)
  onCleanup(() => {
    observer.disconnect()
    window.removeEventListener('resize', place)
    window.removeEventListener('scroll', place, true)
    viewport?.removeEventListener('resize', place)
    viewport?.removeEventListener('scroll', place)
    document.removeEventListener('pointerdown', dismissOutside, true)
    document.removeEventListener('focusin', dismissOutside)
  })
  place()
  await nextTick()
  if (expanded.value === panel) popup.value?.focus({ preventScroll: true })
}, { flush: 'post' })
watch(() => [props.apiBase, props.sessionId], () => {
  expanded.value = null
  scheduledStatus.value = { total: 0, error: '' }
  backgroundStatus.value = { total: 0, loading: false, error: '' }
})
watch(() => props.active, active => { if (active === false) expanded.value = null })
onDeactivated(() => { expanded.value = null })
</script>

<style scoped>
.session-work-controls { min-width: 0; max-width: 100%; margin-top: 8px; }
.session-work-triggers { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.session-work-triggers button {
  display: inline-flex; align-items: center; gap: 8px; max-width: 100%; min-height: 32px;
  padding: 5px 10px; border: 1px solid var(--c-border); border-radius: var(--radius-control);
  background: var(--c-bg-soft); color: var(--c-text-secondary); font: inherit; font-size: 12px; line-height: 20px; cursor: pointer;
}
.session-work-triggers button:hover { color: var(--c-text); background: var(--c-bg-muted); }
.session-work-triggers button[aria-expanded="true"] { border-color: var(--c-selection-border); background: var(--c-selection-bg); color: var(--c-primary); }
.session-work-triggers button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.session-work-triggers svg { width: 14px; height: 14px; flex: 0 0 14px; fill: none; stroke: currentColor; stroke-width: 1.5; }
.session-work-triggers button[aria-expanded="true"] svg { transform: rotate(180deg); }
.session-work-attention { color: var(--c-warn); }
.work-icon { width: 14px; height: 14px; flex: 0 0 14px; }
.subagent-list > p { margin: 8px 0; color: var(--c-text-secondary); }
.subagent-inspect { display: flex; align-items: center; gap: 10px; box-sizing: border-box; width: 100%; padding: 10px 12px; border: 0; border-radius: 0; background: transparent; color: var(--c-text); text-align: left; font: inherit; cursor: pointer; }
.subagent-inspect + .subagent-inspect { border-top: 1px solid var(--c-border-soft); }
.subagent-inspect:hover { background: var(--c-bg-muted); }
.subagent-inspect:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.subagent-copy { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.subagent-copy strong { display: block; font-size: 13px; font-weight: 500; }
.subagent-copy > span { color: var(--c-text-secondary); font-size: 12px; }
.session-work-panel {
  position: fixed; z-index: 950; box-sizing: border-box; overflow-y: auto; overscroll-behavior: contain;
  margin: 0; padding: 12px 16px; border: 1px solid var(--c-border); border-radius: var(--radius-overlay);
  background: var(--c-bg-card); color: var(--c-text); box-shadow: 0 12px 36px var(--c-shadow);
}
/* Separate the popup gutter from the row's content inset; keep focus rings
   inside the gutter and retain the background-task panel's existing spacing. */
.session-work-panel.subagent-panel { padding: 6px; }
.subagent-panel .subagent-list > p { margin: 0; padding: 10px 12px; }
.session-work-panel:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px) {
  .session-work-panel { padding: 12px; }
}
@media (max-width: 700px), (pointer: coarse) {
  .session-work-triggers button { min-height: 44px; }
}
</style>
