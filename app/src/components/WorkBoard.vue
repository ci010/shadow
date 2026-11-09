<template>
  <div ref="board" class="work-board" :class="{ narrow }" :aria-label="t('Work board')">
    <label v-if="narrow" class="lane-picker">{{ t('Work view') }}
      <UiSelect v-model="chosen"><option v-for="column in columns" :key="String(column.status)" :value="String(column.status)">{{ column.label }} · {{ column.rows.length }}</option></UiSelect>
    </label>
    <div class="work-columns">
      <section v-for="column in visibleColumns" :key="String(column.status)" class="work-column" :data-status="String(column.status)" :aria-label="column.label">
        <h3><span :class="`column-dot status-${column.status}`" aria-hidden="true" />{{ column.label }}<span>{{ column.rows.length }}</span></h3>
        <WorkBoardLane :rows="column.rows" :label="column.label" :selected="selected" :session-title="sessionTitle" :session-exists="sessionExists"
          @select="$emit('select', $event)" @session="$emit('session', $event)" />
      </section>
    </div>
  </div>
</template>
<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import type { ProjectWorkItem } from '../../../src/projects/work-overview.ts'
import { workBoardColumns } from '../work-board.ts'
import { t } from '../i18n.ts'
import UiSelect from './UiSelect.vue'
import WorkBoardLane from './WorkBoardLane.vue'
const props = defineProps<{ items: ProjectWorkItem[]; all: ProjectWorkItem[]; selected: string; sessionTitle: (id: string | null) => string; sessionExists: (id: string | null) => boolean }>()
defineEmits<{ select: [key: string]; session: [id: string] }>()
const board = ref<HTMLElement>(), narrow = ref(false), chosen = ref('in_progress')
const columns = computed(() => workBoardColumns(props.items, props.all))
const visibleColumns = computed(() => narrow.value ? columns.value.filter(column => String(column.status) === chosen.value) : columns.value)
watch(columns, () => { if (!columns.value.some(column => String(column.status) === chosen.value)) chosen.value = 'in_progress' })
let observer: ResizeObserver | undefined
onMounted(() => { observer = new ResizeObserver(() => { narrow.value = (board.value?.clientWidth ?? 0) < 900 }); if (board.value) observer.observe(board.value) })
onUnmounted(() => observer?.disconnect())
</script>
<style scoped>
.work-board { display: flex; flex-direction: column; flex: 1; min-height: 0; min-width: 0; overflow: hidden; padding: 12px; background: transparent; }
.work-columns { display: flex; flex: 1; gap: 12px; min-height: 0; overflow-x: auto; overflow-y: hidden; }
.work-column { display: flex; flex-direction: column; flex: 1 0 220px; min-width: 0; min-height: 0; }
.work-column h3 { display: flex; align-items: center; gap: 6px; margin: 0; padding: 4px 3px 12px; font-size: 12px; font-weight: 500; color: var(--c-text-secondary); }
.work-column h3 > span:last-child { margin-left: auto; font-variant-numeric: tabular-nums; }
.column-dot { width: 7px; height: 7px; background: var(--c-text-muted); }
.status-in_progress { background: var(--c-blue); }.status-blocked { background: var(--c-warn); }.status-done { background: var(--c-success); }
.lane-picker { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; font-size: 12px; color: var(--c-text-secondary); }
.lane-picker .ui-select { flex: 1; min-width: 0; }
.narrow .work-column { flex-basis: 0; }
.narrow .work-columns { overflow: hidden; }
</style>
