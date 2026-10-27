<template>
  <span class="session-activity" :class="[activity.kind, { working: activity.working, compact, 'icon-only': iconOnly, 'status-icons': statusIcons }]" :title="label" :aria-label="compact ? label : undefined" :role="compact ? 'img' : undefined">
    <span v-if="!hideSymbol && (iconOnly || stage || !delegatedLabel)" class="activity-symbol" aria-hidden="true">
      <WorkingWave v-if="activity.kind === 'running' && !delegatedRunning" />
      <span v-else-if="compact || statusIcons" :class="statusIcon" class="status-icon" />
      <span v-else-if="activity.kind === 'waiting'" class="i-lucide-message-circle-question attention-icon" />
      <span v-else-if="activity.working && !isWaitingStage(activity.kind)" class="activity-spinner" />
      <span v-else class="activity-dot" />
    </span>
    <span v-if="!iconOnly && (stage || !delegatedLabel) && (!compact || activity.kind === 'waiting')" class="activity-label">{{ compact ? t('Needs reply') : activity.label }}</span>
    <span v-if="delegatedLabel && !iconOnly" class="subagent-activity" :class="subagents?.running ? 'subagent-running' : subagents?.waiting ? 'subagent-waiting' : 'subagent-pending'" :title="delegatedLabel">
      <span class="subagent-symbol" aria-hidden="true">
        <WorkingWave v-if="subagents?.running" />
        <span v-else class="i-lucide-git-branch subagent-icon" />
      </span>
      <span v-if="!iconOnly" class="activity-label">{{ compact ? t('{count} agents', { count: subagentCount }, subagentCount) : delegatedLabel }}</span>
    </span>
  </span>
</template>

<script setup lang="ts">
import WorkingWave from './WorkingWave.vue'
import { t } from '../i18n.ts'
import { computed } from 'vue'
import { isWaitingStage, isWorkingStage, sessionActivity } from '../session-activity.ts'
import { subagentActivityLabel, type SubagentActivity } from '../subagent-executions.ts'

const props = defineProps<{ stage?: string | null; hasCron?: boolean; hasBackgroundTasks?: boolean; compact?: boolean; iconOnly?: boolean; statusIcons?: boolean; hideSymbol?: boolean; subagents?: SubagentActivity }>()
const activity = computed(() => sessionActivity(props.iconOnly && !isWorkingStage(props.stage)
  ? props.subagents?.waiting ? 'waiting' : props.subagents?.running ? 'running' : props.subagents?.pending ? 'pending' : props.stage
  : props.stage))
const delegatedRunning = computed(() => props.iconOnly && !isWorkingStage(props.stage)
  && activity.value.kind === 'running' && !!props.subagents?.running)
const icons: Record<string, string> = {
  llm: 'i-lucide-brain', tool: 'i-lucide-wrench', waiting: 'i-lucide-message-circle-question',
  'waiting-for-call': 'i-lucide-git-branch', idle: 'i-lucide-circle-check', inactive: 'i-lucide-moon',
  pending: 'i-lucide-clock', running: 'i-lucide-play', completed: 'i-lucide-circle-check',
  failed: 'i-lucide-circle-alert', cancelled: 'i-lucide-circle-slash', unknown: 'i-lucide-circle-help',
}
// Active background work outranks schedules, but never foreground/delegated activity or completion.
const statusIcon = computed(() => {
  if (delegatedRunning.value) return 'i-lucide-git-branch'
  if (activity.value.kind === 'inactive') {
    if (props.hasBackgroundTasks) return 'i-lucide-terminal'
    if (props.hasCron) return 'i-lucide-alarm-clock'
  }
  return icons[activity.value.kind]
})
const delegatedLabel = computed(() => subagentActivityLabel(props.subagents))
const subagentCount = computed(() => props.subagents ? props.subagents.running + props.subagents.waiting + props.subagents.pending : 0)
const label = computed(() => [props.stage || !delegatedLabel.value ? activity.value.label : '', delegatedLabel.value].filter(Boolean).join(' · '))
</script>

<style scoped>
.session-activity { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; vertical-align: middle; }
.session-activity.completed { color: var(--c-success); }
.session-activity.failed { color: var(--c-error); }
.session-activity.waiting { color: var(--c-warn); }
.session-activity:is(.compact, .status-icons):is(.llm, .tool, .running, .waiting-for-call, .pending) { color: var(--c-info); }
.session-activity.waiting.compact { gap: 4px; padding: 2px 5px; background: var(--c-warn-bg); border: 1px solid var(--c-warn); border-radius: var(--radius-control); }
.attention-icon { width: 16px; height: 16px; }
.status-icon { width: 16px; height: 16px; }
.session-activity.inactive, .session-activity.unknown { color: var(--c-text-muted); }
.session-activity.cancelled { color: var(--c-text-muted); }
.activity-symbol { position: relative; display: grid; place-items: center; width: 16px; height: 16px; }
.activity-spinner { box-sizing: border-box; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-bottom-color: transparent; border-radius: 50%; animation: activity-spin .8s linear infinite; }
.activity-dot { width: 6px; height: 6px; border: 1px solid currentColor; border-radius: var(--radius-circle); }
.idle .activity-dot { background: currentColor; }
.activity-symbol:has(> .activity-spinner)::after { content: ''; position: absolute; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .7; }
.activity-label { font-weight: 500; white-space: nowrap; }
.compact { padding: 3px; }
.session-activity.compact.icon-only { width: 16px; height: 16px; gap: 0; padding: 0; border: 0; background: transparent; }
.subagent-activity { display: inline-flex; align-items: center; gap: 4px; color: var(--c-primary); }
.subagent-waiting { color: var(--c-warn); }
.subagent-pending { color: var(--c-text-muted); }
.subagent-symbol { display: grid; place-items: center; position: relative; width: 20px; height: 20px; flex: 0 0 20px; }
.subagent-icon { width: 12px; height: 12px; }
@keyframes activity-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .activity-spinner { animation: none; } }
</style>
