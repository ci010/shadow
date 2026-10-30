<template>
  <span class="copy-icon-control">
    <HoverInfo :text="copied ? t('Copied') : label" v-slot="{ triggerProps }">
      <button v-bind="triggerProps" type="button" :aria-label="copied ? t('Copied') : label" :disabled="busy" @click="copy">
        <span :class="copied ? 'i-lucide-check' : icon" aria-hidden="true" />
      </button>
    </HoverInfo>
    <span v-if="error" class="copy-error" role="alert">{{ error }}</span>
  </span>
</template>

<script setup lang="ts">
import HoverInfo from './HoverInfo.vue'
import { useTextCopy } from '../composables/useTextCopy.ts'
import { t } from '../i18n.ts'
const props = withDefaults(defineProps<{ value: string; label: string; icon?: string }>(), { icon: 'i-lucide-copy' })
const { copied, busy, error, copy } = useTextCopy(() => props.value)
</script>

<style scoped>
.copy-icon-control { display: inline-flex; align-items: center; }
button { display: grid; place-items: center; width: 28px; height: 28px; padding: 0; border: 0; background: var(--c-bg-card); color: var(--c-text-secondary); cursor: pointer; }
button:hover { background: var(--c-bg-muted); color: var(--c-text); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
button:disabled { opacity: .5; cursor: wait; }
button span { width: 14px; height: 14px; }
.copy-error { color: var(--c-error); font-size: 12px; white-space: normal; }
@media (pointer: coarse) { button { width: 36px; height: 36px; } }
</style>
