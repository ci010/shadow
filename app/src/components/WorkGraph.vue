<template>
  <section class="work-graph" :aria-label="t('Work relationships')">
    <p class="graph-legend"><span class="child-line" /> {{ t('Parent → child') }} <span class="dependency-line" /> {{ t('Prerequisite → dependent') }}
      <span v-if="layout.outside">{{ layout.outside }} {{ t('links leave this filtered view.') }}</span>
    </p>
    <p v-if="items.length > 200" role="status">{{ t('Too many items for a readable graph. Filter to an Initiative or session, or use the board.') }}</p>
    <div v-else class="graph-scroll" tabindex="0" :aria-label="t('Scrollable work graph')">
      <div class="graph-canvas" :style="{ width: `${layout.width}px`, height: `${layout.height}px` }">
        <svg :width="layout.width" :height="layout.height" aria-hidden="true">
          <defs><marker :id="markerId" markerWidth="7" markerHeight="7" refX="6" refY="3.5" orient="auto"><path d="M0,0 L7,3.5 L0,7" fill="context-stroke" /></marker></defs>
          <path v-for="edge in layout.edges" :key="`${edge.kind}:${edge.from}:${edge.to}`" :d="edge.path"
            :class="edge.kind" :marker-end="`url(#${markerId})`" />
        </svg>
        <WorkItemCard v-for="node in layout.nodes" :key="node.item.key" class="graph-node"
          :style="{ left: `${node.x}px`, top: `${node.y}px` }" :item="node.item" :selected="selected === node.item.key"
          :session-title="sessions.find(session => session.sessionId === node.item.assignee)?.title ?? ''"
          :session-exists="sessions.some(session => session.sessionId === node.item.assignee)"
          @select="$emit('select', $event)" @session="$emit('session', $event)" />
      </div>
    </div>
  </section>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, useId } from 'vue'
import type { ProjectWorkItem } from '../../../src/projects/work-overview.ts'
import { workGraph } from '../project-work.ts'
import WorkItemCard from './WorkItemCard.vue'
const props = defineProps<{ items: ProjectWorkItem[]; selected: string; sessions: { sessionId: string; title: string }[] }>()
defineEmits<{ select: [key: string]; session: [id: string] }>()
const markerId = useId()
const layout = computed(() => workGraph(props.items.length <= 200 ? props.items : []))
</script>
<style scoped>
.work-graph { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.graph-legend { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; padding: 0 16px; font-size: 12px; color: var(--c-text-secondary); }
.child-line, .dependency-line { width: 24px; border-top: 1px solid var(--c-border-hover); }
.dependency-line { border-top: 1px dashed var(--c-blue); }
.graph-scroll { flex: 1; overflow: auto; min-height: 200px; background: var(--c-bg-soft); }
.graph-scroll:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.graph-canvas { position: relative; }
svg { position: absolute; inset: 0; pointer-events: none; }
svg > path { fill: none; stroke: var(--c-border-hover); stroke-width: 1.5; }
svg > path.dependency { stroke: var(--c-blue); stroke-dasharray: 5 4; }
.graph-node { position: absolute; box-sizing: border-box; width: 256px; min-height: 136px; max-height: 160px; overflow-y: auto; }
</style>
