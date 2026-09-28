<template>
  <article class="work-item-card" :class="{ selected }" :data-work-key="item.key">
    <button type="button" class="work-title" :aria-pressed="selected" @click="$emit('select', item.key)">{{ item.title }}</button>
    <div class="work-item-state"><span :class="`status-${item.status}`">{{ workStatus(item) }}</span>
      <span v-if="item.paused">Paused</span>
      <span v-if="item.proposals" class="review">Review needed</span>
      <span v-else-if="item.interpretationReview" class="review">Clarification needed</span>
    </div>
    <button v-if="item.assignee && sessionExists" type="button" class="work-assignee" :title="item.assignee" @click="$emit('session', item.assignee)">
      <span class="i-lucide-message-square" aria-hidden="true" />{{ sessionTitle }}<span class="i-lucide-arrow-up-right" aria-hidden="true" />
    </button>
    <span v-else class="work-unassigned">{{ item.assignee ? 'Session unavailable' : 'Unassigned' }}</span>
    <p v-if="item.blockedReason" class="work-blocker">{{ item.blockedReason }}</p>
    <p v-if="item.dependencies.length" class="work-dependencies">{{ item.dependencies.length }} {{ item.dependencies.length === 1 ? 'dependency' : 'dependencies' }}</p>
    <p v-for="link in item.github" :key="link.url" class="work-github">
      <a :href="link.url" target="_blank" rel="noopener noreferrer">{{ link.repository }}#{{ link.number }}</a>
      · {{ link.state }}<template v-if="link.ci"> · CI {{ link.ci }} · {{ link.review }}</template>
    </p>
  </article>
</template>
<script setup lang="ts">
import type { ProjectWorkItem } from '../../../src/projects/work-overview.ts'
import { workStatus } from '../project-work.ts'
defineProps<{ item: ProjectWorkItem; selected: boolean; sessionTitle: string; sessionExists: boolean }>()
defineEmits<{ select: [key: string]; session: [id: string] }>()
</script>
<style scoped>
.work-item-card { min-width: 0; padding: 12px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); }
.work-item-card.selected { border-color: var(--c-selection-border); background: var(--c-selection-bg); }
button { font: inherit; text-align: left; cursor: pointer; border: 0; background: transparent; color: inherit; padding: 0; }
.work-title { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; width: 100%; min-height: 36px; font-size: 13px; font-weight: 600; line-height: 18px; overflow-wrap: anywhere; }
.work-title:hover { text-decoration: underline; }
.work-item-state { display: flex; flex-wrap: wrap; gap: 8px; margin: 8px 0; font-size: 12px; color: var(--c-text-secondary); }
.status-in_progress { color: var(--c-primary); }
.status-blocked, .review { color: var(--c-warn); }
.status-done { color: var(--c-success); }
.work-assignee { display: flex; align-items: center; gap: 5px; max-width: 100%; min-height: 28px; font-size: 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.work-assignee:hover { color: var(--c-primary); }
.work-assignee span { width: 12px; height: 12px; flex-shrink: 0; }
.work-unassigned, .work-dependencies { font-size: 12px; color: var(--c-text-secondary); }
.work-dependencies { margin: 3px 0 0; }
.work-github { font-size: 12px; margin: 8px 0 0; overflow-wrap: anywhere; color: var(--c-text-secondary); }
.work-github a { color: var(--c-primary); }
.work-blocker { margin: 8px 0 0; font-size: 12px; line-height: 1.5; color: var(--c-warn); overflow-wrap: anywhere; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
@media (pointer: coarse) { button { min-height: 44px; } }
</style>
