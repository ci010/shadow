<template>
  <article class="message-preview-card" :data-expanded="expanded" :data-collapsible="collapsible"
    @click="!expanded && toggle()" @message-card-expand="opened = true">
    <div class="message-preview-header" @click.stop="toggle">
      <slot name="heading" />
      <button v-if="collapsible" type="button" class="message-preview-toggle" :aria-label="label" :aria-expanded="expanded"
        :aria-controls="bodyId" @click.stop="toggle">
        <span class="message-preview-chevron i-lucide-chevron-down" aria-hidden="true" />
      </button>
    </div>
    <div :id="bodyId" class="message-preview-body" :inert="!expanded">
      <div class="message-preview-content">
        <slot />
        <div v-if="$slots.details" class="message-preview-details" :aria-hidden="!expanded"><slot name="details" /></div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'

const props = withDefaults(defineProps<{ label: string; collapsible?: boolean }>(), { collapsible: true })
const emit = defineEmits<{ interact: [] }>()
const opened = ref(false)
const expanded = computed(() => opened.value || !props.collapsible)
const bodyId = useId()
function toggle() {
  if (!props.collapsible) return
  emit('interact')
  opened.value = !opened.value
}
</script>

<style scoped>
.message-preview-card { box-sizing: border-box; width: 100%; min-width: 0; padding: 8px 12px; border: 1px solid var(--c-chat-border); border-radius: var(--radius-surface); background: var(--c-chat-action-bg); color: var(--c-text-secondary); font-size: 0.8rem; line-height: 1.5; }
.message-preview-card[data-expanded="false"] { cursor: pointer; }
.message-preview-header { display: flex; align-items: center; gap: 8px; min-width: 0; min-height: 28px; font-size: 12px; line-height: 20px; }
.message-preview-toggle { display: flex; align-items: center; justify-content: center; flex: 0 0 28px; width: 28px; height: 28px; margin-left: auto; padding: 0; border: 0; background: transparent; color: inherit; cursor: pointer; }
.message-preview-toggle:hover { background: var(--c-bg-muted); color: var(--c-text); }
.message-preview-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.message-preview-chevron { width: 14px; height: 14px; transition: transform 180ms cubic-bezier(.22, 1, .36, 1); }
.message-preview-card[data-expanded="true"] .message-preview-chevron { transform: rotate(180deg); }
.message-preview-body { position: relative; display: grid; grid-template-rows: 0fr; min-width: 0; margin-top: 4px; color: var(--c-text); overflow-wrap: anywhere; transition: grid-template-rows 160ms cubic-bezier(.22, 1, .36, 1); }
.message-preview-card[data-expanded="true"] .message-preview-body { grid-template-rows: 1fr; transition-duration: 220ms; }
.message-preview-content { min-height: 5lh; overflow: hidden; }
.message-preview-card[data-expanded="true"] .message-preview-content { min-height: 0; }
.message-preview-body::after { content: ''; position: absolute; inset: auto 0 0; height: 2lh; background: linear-gradient(to bottom, transparent, var(--c-chat-action-bg)); pointer-events: none; opacity: 1; transition: opacity 160ms ease-out; }
.message-preview-card[data-expanded="true"] .message-preview-body::after { opacity: 0; }
.message-preview-card[data-expanded="false"] .message-preview-details { visibility: hidden; }
.message-preview-card[data-collapsible="false"] .message-preview-content { min-height: 0; }
@media (prefers-reduced-motion: reduce) {
  .message-preview-body, .message-preview-chevron, .message-preview-body::after { transition: none; }
}
</style>
