<template>
  <span class="session-activity" :class="[activity.kind, { working: activity.working, compact }]" :title="activity.label" :aria-label="compact ? activity.label : undefined" :role="compact ? 'img' : undefined">
    <span class="activity-symbol" aria-hidden="true">
      <span v-if="activity.kind === 'waiting'" class="i-lucide-message-circle-question attention-icon" />
      <span v-else-if="activity.working && !isWaitingStage(activity.kind)" class="activity-spinner" />
      <span v-else class="activity-dot" />
    </span>
    <span v-if="!compact || activity.kind === 'waiting' && !iconOnly" class="activity-label">{{ compact ? 'Needs reply' : activity.label }}</span>
  </span>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { isWaitingStage, sessionActivity } from '../session-activity.ts'

const props = defineProps<{ stage?: string | null; compact?: boolean; iconOnly?: boolean }>()
const activity = computed(() => sessionActivity(props.stage))
</script>

<style scoped>
.session-activity { display: inline-flex; flex: 0 0 auto; align-items: center; gap: 7px; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; vertical-align: middle; }
.session-activity.completed { color: var(--c-success); }
.session-activity.failed { color: var(--c-error); }
.session-activity.waiting { color: var(--c-warn); }
.session-activity.waiting.compact { gap: 4px; padding: 2px 5px; background: var(--c-warn-bg); border: 1px solid var(--c-warn); border-radius: var(--radius-control); }
.attention-icon { width: 16px; height: 16px; }
.session-activity.inactive, .session-activity.unknown { color: var(--c-text-muted); }
.activity-symbol { position: relative; display: grid; place-items: center; width: 16px; height: 16px; }
.activity-spinner { box-sizing: border-box; width: 14px; height: 14px; border: 2px solid currentColor; border-right-color: transparent; border-bottom-color: transparent; border-radius: 50%; animation: activity-spin .8s linear infinite; }
.activity-dot { width: 6px; height: 6px; border: 1px solid currentColor; border-radius: var(--radius-circle); }
.idle .activity-dot { background: currentColor; }
.working:not(.waiting):not(.waiting-for-call) .activity-symbol::after { content: ''; position: absolute; width: 4px; height: 4px; border-radius: 50%; background: currentColor; opacity: .7; }
.activity-label { font-weight: 500; white-space: nowrap; }
.compact { padding: 3px; }
@keyframes activity-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .activity-spinner { animation: none; } }
</style>
