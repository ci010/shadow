<template>
  <span class="line-changes" :aria-label="`${changes.added} lines added, ${changes.removed} lines removed`" :title="partial ? 'Known line changes; some older or unreadable edits have no counts' : 'Line changes across these operations, not a net Git diff'">
    <span class="lines-added">+{{ changes.added }}</span>
    <span class="lines-removed">-{{ changes.removed }}</span>
    <span v-if="partial" class="partial-count" aria-label="Partial counts">*</span>
  </span>
</template>

<script setup lang="ts">
import type { LineChanges } from '../tool-activity.ts'
defineProps<{ changes: LineChanges; partial?: boolean }>()
</script>

<style scoped>
.line-changes { display: inline-flex; align-items: center; flex-shrink: 0; gap: 6px; font-size: 12px; font-variant-numeric: tabular-nums; line-height: 20px; white-space: nowrap; }
.lines-added { color: var(--c-diff-added); }
.lines-removed { color: var(--c-error); }
.partial-count { color: var(--c-text-secondary); }
</style>
