<script setup lang="ts">
import { Handle, Position } from '@vue-flow/core'
import { t } from '../i18n.ts'
import type { OverviewNode } from '../project-overview-graph.ts'
defineProps<{ data: { node: OverviewNode; role: string; authority: string; status: string; children: number; expanded: boolean; disclosure: string; selected: boolean; activate: () => void } }>()
</script>
<template>
  <div class="flow-card" :class="[data.node.kind, { selected: data.selected }]">
    <Handle type="target" :position="Position.Top" :connectable="false" />
    <button class="nodrag" :data-node-id="data.node.id" :aria-expanded="data.children ? data.expanded : undefined" :aria-pressed="data.selected" @click.stop="data.activate" @keydown.enter.stop.prevent="data.activate" @keydown.space.stop.prevent="data.activate">
      <span class="kind">{{ data.role }}<span v-if="data.status" class="status">{{ data.status }}</span></span>
      <strong :title="data.node.title">{{ data.node.kind === 'group' && data.node.authority === 'unknown' ? t('Unorganized topics') : data.node.title }}</strong>
      <span class="authority">{{ data.authority }}</span>
      <span v-if="data.children" class="disclosure">{{ data.expanded ? '−' : '+' }} {{ data.disclosure }} · {{ data.children }}</span>
    </button>
    <Handle type="source" :position="Position.Bottom" :connectable="false" />
  </div>
</template>
<style scoped>
.flow-card { width:280px;height:112px;border-radius:10px;border:1px solid var(--c-border);border-top:3px solid var(--c-blue);background:var(--c-bg-card);box-shadow:0 3px 12px #00000012;box-sizing:border-box; }
.flow-card.decision { border-top-color:var(--c-success); }.flow-card.result { border-top-color:var(--c-warn); }.flow-card.unavailable { border-top-color:var(--c-text-muted); }
.flow-card.selected { border-color:var(--c-blue);box-shadow:0 0 0 2px var(--c-selection-bg); }
button { width:100%;height:100%;padding:9px 12px;display:flex;flex-direction:column;gap:4px;text-align:left;border:0;border-radius:8px;background:transparent;color:var(--c-text);cursor:pointer; }
button:hover { background:var(--c-bg-soft); }button:focus-visible { outline:2px solid var(--c-blue);outline-offset:3px; }
.kind,.authority,.disclosure { font-size:11px;color:var(--c-text-secondary); }.kind { display:flex;justify-content:space-between;width:100%;gap:6px; }.status { overflow:hidden;text-overflow:ellipsis;white-space:nowrap; }
strong { font-size:13px;line-height:17px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden; }.authority { white-space:nowrap;max-width:100%;overflow:hidden;text-overflow:ellipsis; }.disclosure { margin-top:auto;color:var(--c-blue); }
:deep(.vue-flow__handle) { width:5px;height:5px;background:var(--c-text-muted);border:0;pointer-events:none; }
</style>
