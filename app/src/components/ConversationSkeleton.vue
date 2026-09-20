<template>
  <div class="conversation-skeleton" :class="{ paused: !active || hidden }" role="status" aria-label="Loading conversation">
    <span class="skeleton-label">Loading conversation...</span>
    <div class="skeleton-thread" aria-hidden="true">
      <div class="skeleton-message skeleton-user"><i /><i /></div>
      <div class="skeleton-message skeleton-assistant"><i /><i /><i /></div>
      <div class="skeleton-message skeleton-user skeleton-short"><i /></div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'
withDefaults(defineProps<{ active?: boolean }>(), { active: true })
const hidden = ref(false)
function updateVisibility() { hidden.value = document.hidden }
onMounted(() => {
  updateVisibility()
  document.addEventListener('visibilitychange', updateVisibility)
})
onUnmounted(() => document.removeEventListener('visibilitychange', updateVisibility))
</script>

<style scoped>
.conversation-skeleton { width: 100%; padding-block: 8px 24px; }
.skeleton-label { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
.skeleton-thread { display: flex; flex-direction: column; gap: 24px; }
.skeleton-message { display: flex; flex-direction: column; gap: 10px; width: 68%; padding: 16px; border-radius: var(--radius-surface); }
.skeleton-user { align-self: flex-end; width: 46%; background: var(--c-bg-muted); }
.skeleton-short { width: 32%; }
.skeleton-message i { display: block; height: 10px; background: var(--c-border-soft); border-radius: var(--radius-sm); animation: conversation-pulse 1.6s ease-in-out infinite; }
.skeleton-message i:last-child { width: 62%; }
.skeleton-assistant i { animation-delay: 160ms; }
.skeleton-short i { width: 80%; animation-delay: 320ms; }
.paused i { animation-play-state: paused; }
@keyframes conversation-pulse { 0%, 100% { opacity: .4; } 50% { opacity: 1; } }
@media (prefers-reduced-motion: reduce) { .skeleton-message i { animation: none; opacity: .65; } }
</style>
