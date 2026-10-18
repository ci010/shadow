<template>
  <details v-if="text.trim()" v-disclosure-motion class="reasoning-item" :open="expanded" @toggle.self="onToggle">
    <summary class="reasoning-header" @click="$emit('interact')">
      <span class="reasoning-disclosure-icon" aria-hidden="true">
        <span class="reasoning-icon i-lucide-brain" />
        <span class="reasoning-chevron i-lucide-chevron-right" />
      </span>
      <span>{{ t('Thinking') }}</span>
    </summary>
    <div v-if="expanded && active" class="thinking-content prose" v-answer-html v-html="renderContent(text)" />
    <slot v-if="expanded && active" />
  </details>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '../i18n.ts'
import { vDisclosureMotion } from '../disclosure-motion.ts'
import { vAnswerHtml } from '../answer-html.ts'
const props = withDefaults(defineProps<{ text: string; renderContent: (text: string) => string; open?: boolean; active?: boolean }>(), { open: false, active: true })
const emit = defineEmits<{ interact: []; 'update:open': [open: boolean] }>()
const expanded = ref(props.open)
watch(() => props.open, open => { expanded.value = open })
function onToggle(event: Event) {
  expanded.value = (event.currentTarget as HTMLDetailsElement).open
  emit('update:open', expanded.value)
}
</script>

<style scoped>
.reasoning-item { min-width: 0; width: 100%; color: var(--c-text-secondary); font-size: 13px; }
.reasoning-header { display: flex; align-items: center; gap: 8px; min-height: 32px; padding: 4px; border-radius: var(--radius-control); line-height: 20px; list-style: none; cursor: pointer; }
.reasoning-header::-webkit-details-marker { display: none; }
.reasoning-header:hover, .reasoning-header:focus-visible { background: var(--c-bg-muted); color: var(--c-text); }
.reasoning-header:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.reasoning-disclosure-icon { position: relative; flex: 0 0 16px; width: 16px; height: 16px; }
.reasoning-disclosure-icon > span { position: absolute; inset: 0; pointer-events: none; }
.reasoning-icon { transition: opacity 140ms ease-out; }
.reasoning-chevron { opacity: 0; transition: opacity 140ms ease-out, transform 200ms cubic-bezier(.22, 1, .36, 1); }
.reasoning-header:is(:hover, :focus-visible) .reasoning-icon, details[data-expanded="true"] > summary .reasoning-icon { opacity: 0; }
.reasoning-header:is(:hover, :focus-visible) .reasoning-chevron, details[data-expanded="true"] > summary .reasoning-chevron { opacity: 1; }
details[data-expanded="true"] > summary .reasoning-chevron { transform: rotate(90deg); }
.thinking-content { padding: 4px 8px 12px 28px; font-size: 0.75rem; line-height: 1.5; }
@media (max-width: 480px) { .thinking-content { padding-left: 8px; } }
@media (prefers-reduced-motion: reduce) { .reasoning-icon, .reasoning-chevron { transition: none; } }
</style>
