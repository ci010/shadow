<template>
  <div class="copyable-id">
    <span class="copy-value selectable-text">{{ value }}</span>
    <button type="button" :aria-label="copied ? `${label} copied` : `Copy ${label}`" :disabled="busy" @click="copy">
      <span :class="copied ? 'i-lucide-check' : 'i-lucide-copy'" aria-hidden="true" />
    </button>
    <span v-if="copied" class="copy-feedback" role="status">Copied</span>
    <span v-if="error" class="copy-error" role="alert">{{ error }}</span>
  </div>
</template>

<script setup lang="ts">
import { useTextCopy } from '../composables/useTextCopy.ts'

const props = defineProps<{ value: string; label: string }>()
const { copied, busy, error, copy } = useTextCopy(() => props.value)
</script>

<style scoped>
.copyable-id { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: start; gap: 4px 8px; min-width: 0; }
.copy-value { min-width: 0; padding-block: 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; user-select: text; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
button { display: grid; place-items: center; width: 32px; height: 32px; padding: 0; border: 1px solid transparent; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
button span { width: 14px; height: 14px; }
button:hover { background: var(--c-bg-muted); color: var(--c-text); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
button:disabled { opacity: .5; cursor: wait; }
.copy-feedback, .copy-error { grid-column: 1 / -1; font-size: 12px; line-height: 1.5; }
.copy-feedback { color: var(--c-success); }
.copy-error { color: var(--c-error); }
@media (max-width: 700px), (pointer: coarse) { button { width: 44px; height: 44px; } }
</style>
