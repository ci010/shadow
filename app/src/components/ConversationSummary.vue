<template>
  <details class="compaction-summary" @toggle.self="onToggle">
    <summary class="compaction-summary-header" @click="emit('interact')">
      <span class="summary-icon i-lucide-history" aria-hidden="true" />
      <span class="compaction-summary-title">{{ t('Previous Conversation Summary') }}</span>
      <span class="summary-chevron i-lucide-chevron-right" aria-hidden="true" />
    </summary>
    <div v-if="expanded" class="compaction-summary-body prose" v-markdown-link-hints v-html="renderContent(content)" />
  </details>
</template>

<script setup lang="ts">
import { vMarkdownLinkHints } from '../markdown-link-hints'
import { t } from '../i18n.ts'
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
  border: 1px solid var(--c-chat-border);
  border-radius: var(--radius-surface);
  background: var(--c-chat-action-bg);
  color: var(--c-text-secondary);
}
.compaction-summary-header {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 40px;
  padding: 12px;
  box-sizing: border-box;
  list-style: none;
  cursor: pointer;
  font-size: 13px;
  line-height: 1.5;
}
.compaction-summary-header::-webkit-details-marker { display: none; }
.compaction-summary-header:hover { background: var(--c-bg-muted); color: var(--c-text); }
.compaction-summary-header:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.summary-icon, .summary-chevron { display: block; width: 16px; height: 16px; flex: 0 0 16px; }
.compaction-summary[open] > summary { border-bottom: 1px solid var(--c-chat-border); }
.compaction-summary[open] > summary .summary-chevron { transform: rotate(90deg); }
.compaction-summary-title { flex: 1; min-width: 0; color: var(--c-text); font-weight: 500; overflow-wrap: anywhere; }
.compaction-summary-body {
  box-sizing: border-box;
  max-width: 72ch;
  margin: 0;
  padding: 12px;
  color: var(--c-text-body);
  font-size: 13px;
  line-height: 1.6;
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
@media (max-width: 700px), (pointer: coarse) {
  .compaction-summary-header { min-height: 44px; }
}
</style>
