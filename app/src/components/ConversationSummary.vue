<template>
  <details class="compaction-summary" @toggle.self="onToggle">
    <summary class="compaction-summary-header" @click="emit('interact')">
      <span class="summary-chevron i-lucide-chevron-right" aria-hidden="true" />
      <span class="compaction-summary-title">Previous Conversation Summary</span>
    </summary>
    <div v-if="expanded" class="compaction-summary-body prose" v-html="renderContent(content)" />
  </details>
</template>

<script setup lang="ts">
import { ref } from 'vue'

defineProps<{ content: string; renderContent: (content: string) => string }>()
const emit = defineEmits<{ interact: [] }>()
const expanded = ref(false)

function onToggle(event: Event) {
  if (event.currentTarget instanceof HTMLDetailsElement) expanded.value = event.currentTarget.open
}
</script>

<style scoped>
.compaction-summary {
  width: 100%;
  min-width: 0;
  border-radius: var(--radius-surface);
  color: var(--c-text-secondary);
}
.compaction-summary-header {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 40px;
  padding: 8px 0;
  box-sizing: border-box;
  list-style: none;
  cursor: pointer;
  font-size: 12px;
  line-height: 20px;
}
.compaction-summary-header::-webkit-details-marker { display: none; }
.compaction-summary-header::after { content: ''; flex: 1; min-width: 16px; border-top: 1px solid var(--c-border); }
.compaction-summary-header:hover { color: var(--c-text); }
.compaction-summary-header:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.summary-chevron { display: block; width: 14px; height: 14px; flex: 0 0 14px; }
.compaction-summary[open] > summary .summary-chevron { transform: rotate(90deg); }
.compaction-summary-title { min-width: 0; font-weight: 500; overflow-wrap: anywhere; }
.compaction-summary-body {
  box-sizing: border-box;
  max-width: 76ch;
  margin: 0 0 16px;
  padding: 4px 0 12px 22px;
  color: var(--c-text);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.compaction-summary-body :deep(h1),
.compaction-summary-body :deep(h2),
.compaction-summary-body :deep(h3),
.compaction-summary-body :deep(h4),
.compaction-summary-body :deep(h5),
.compaction-summary-body :deep(h6) { margin: 20px 0 8px; font-size: 14px; font-weight: 600; line-height: 1.5; }
.compaction-summary-body :deep(p),
.compaction-summary-body :deep(ul),
.compaction-summary-body :deep(ol) { margin: 8px 0; }
.compaction-summary-body :deep(ul),
.compaction-summary-body :deep(ol) { padding-left: 20px; }
.compaction-summary-body :deep(li) { margin: 4px 0; }
.compaction-summary-body :deep(pre) { max-width: 100%; overflow-x: auto; font-size: 12px; }
.compaction-summary-body :deep(table) { display: block; max-width: 100%; overflow-x: auto; font-size: 12px; }
.compaction-summary-body :deep(> :first-child) { margin-top: 0; }
.compaction-summary-body :deep(> :last-child) { margin-bottom: 0; }
</style>
