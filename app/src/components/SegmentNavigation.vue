<template>
  <nav class="segment-nav" :aria-label="t('Conversation segments')" :aria-busy="busy">
    <span class="segment-position" role="status">{{ historical ? t('Viewing previous session') : t('Current session') }}</span>
    <HoverInfo :text="historical ? t('View older session') : t('View previous session')">
      <template #default="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="segment-nav-btn" :aria-label="t('View previous session')"
          :disabled="busy || !hasPrevious" @click="$emit('previous')">
          <svg viewBox="0 0 24 20" aria-hidden="true"><path d="m6 5-5 5 5 5M1 10h5m14 0h3" /><circle cx="13" cy="10" r="6" /></svg>
        </button>
      </template>
    </HoverInfo>
    <HoverInfo :text="historical ? t('Back to current session') : t('Current session')">
      <template #default="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="segment-nav-btn" :class="{ 'is-current': !historical }"
          :aria-label="t('Back to current session')" :disabled="busy || !historical" @click="$emit('current')">
          <svg viewBox="0 0 24 20" aria-hidden="true"><path d="M1 10h5m12 0h5" /><circle cx="12" cy="10" r="6" /></svg>
        </button>
      </template>
    </HoverInfo>
    <HoverInfo :text="t('View next session')">
      <template #default="{ triggerProps }">
        <button v-bind="triggerProps" type="button" class="segment-nav-btn" :aria-label="t('View next session')"
          :disabled="busy || !historical" @click="$emit('next')">
          <svg viewBox="0 0 24 20" aria-hidden="true"><path d="m18 5 5 5-5 5m0-5h5M1 10h3" /><circle cx="11" cy="10" r="6" /></svg>
        </button>
      </template>
    </HoverInfo>
    <slot />
  </nav>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
defineProps<{ hasPrevious: boolean; historical: boolean; busy: boolean }>()
defineEmits<{ previous: []; next: []; current: [] }>()
</script>

<style scoped>
.segment-nav { display: flex; align-items: center; flex: 0 0 auto; gap: 2px; padding-inline: 8px; }
.segment-nav-btn { display: grid; place-items: center; width: 32px; height: 32px; padding: 4px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); cursor: pointer; }
.segment-nav-btn svg { width: 22px; height: 20px; fill: none; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; stroke-linejoin: round; }
.segment-nav-btn:hover:not(:disabled) { color: var(--c-text); background: var(--c-bg-muted); }
.segment-nav-btn:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.segment-nav-btn:disabled { opacity: .4; cursor: default; }
.segment-nav-btn.is-current { color: var(--c-primary); opacity: 1; }
.segment-nav-btn.is-current circle { fill: var(--c-selection-bg); }
.segment-position { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@media (max-width: 700px), (pointer: coarse) { .segment-nav-btn { width: 44px; height: 44px; } }
</style>
