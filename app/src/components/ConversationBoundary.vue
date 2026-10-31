<template>
  <details class="history-disclosure conversation-boundary" :data-history-boundary="previousId">
    <summary><span class="history-chevron i-lucide-chevron-right" aria-hidden="true" />{{ t('History') }}</summary>
    <div class="boundary-body">
      <p>{{ t('Previous segment') }} <span>{{ previousId }}</span></p>
      <button type="button" @click="emit('select', previousId)">{{ t('View previous segment') }}</button>
    </div>
  </details>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
defineProps<{ previousId: string }>()
const emit = defineEmits<{ select: [id: string] }>()
</script>

<style scoped>
.conversation-boundary { color: var(--c-text-secondary); border-top: 1px solid var(--c-border-soft); }
summary { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px; box-sizing: border-box; list-style: none; cursor: pointer; font-size: 12px; line-height: 20px; font-weight: 500; }
summary::-webkit-details-marker { display: none; }
summary:hover { background: var(--c-bg-soft); color: var(--c-text); }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.history-chevron { flex: 0 0 14px; width: 14px; height: 14px; }
details[open] > summary .history-chevron { transform: rotate(90deg); }
.boundary-body { margin: 0 8px 12px 22px; font-size: 12px; overflow-wrap: anywhere; }
p { margin: 4px 0 8px; }
button { min-height: 40px; padding: 8px; color: var(--c-primary); background: transparent; border: 1px solid var(--c-border); cursor: pointer; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (pointer: coarse) { summary, button { min-height: 44px; } }
</style>
