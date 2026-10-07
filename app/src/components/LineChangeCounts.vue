<template>
  <span class="line-changes" :aria-label="t('{added} lines added, {removed} lines removed', { added: changes.added, removed: changes.removed })" :title="partial ? t('Known line changes; some older or unreadable edits have no counts') : t('Line changes across these operations, not a net Git diff')">
    <span class="lines-added">+{{ changes.added }}</span>
    <span class="lines-removed">-{{ changes.removed }}</span>
    <span v-if="partial" class="partial-count" :aria-label="t('Partial counts')">*</span>
  </span>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import type { LineChanges } from '../tool-activity.ts'
defineProps<{ changes: LineChanges; partial?: boolean }>()
</script>

<style scoped>
.line-changes { display: inline-flex; align-items: center; flex-shrink: 0; gap: 6px; font-size: 12px; font-variant-numeric: tabular-nums; line-height: 20px; white-space: nowrap; }
.lines-added { color: var(--c-diff-added); }
.lines-removed { color: var(--c-error); }
.partial-count { color: var(--c-text-secondary); }
</style>
