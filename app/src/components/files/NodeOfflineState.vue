<template>
  <div class="node-offline" role="status" :aria-busy="checking">
    <div class="node-offline-heading"><span class="i-lucide-cloud-off" aria-hidden="true" /><strong>{{ t('Node offline') }}</strong></div>
    <p>{{ description }}</p>
    <button class="node-offline-check" :disabled="checking" @click="$emit('retry')">
      <span class="i-lucide-refresh-cw" aria-hidden="true" />{{ checking ? t('Checking…') : t('Check again') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
withDefaults(defineProps<{ checking?: boolean; description?: string }>(), {
  checking: false,
  get description() { return t('Files and Git changes will be available when the owning node reconnects.') },
})
defineEmits<{ retry: [] }>()
</script>

<style scoped>
.node-offline { padding: 16px 8px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.5; overflow-wrap: anywhere; }
.node-offline-heading { display: flex; align-items: center; gap: 8px; color: var(--c-text); }
.node-offline-heading > span, .node-offline-check > span { flex: 0 0 16px; width: 16px; height: 16px; }
.node-offline-heading strong { font-weight: 500; }
.node-offline p { margin: 8px 0 12px; }
.node-offline-check { display: inline-flex; align-items: center; gap: 6px; min-height: 32px; padding: 6px 8px; border: 1px solid var(--c-border); border-radius: var(--radius-control); background: var(--c-bg-card); color: var(--c-text-secondary); font: inherit; cursor: pointer; }
.node-offline-check:hover:not(:disabled) { background: var(--c-bg-muted); color: var(--c-text); }
.node-offline-check:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.node-offline-check:disabled { opacity: .5; cursor: wait; }
</style>
