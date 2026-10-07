<template>
  <details class="collaboration-message" @toggle="opened = ($event.currentTarget as HTMLDetailsElement).open">
    <summary><strong>{{ t('Collaboration update') }}</strong><span>{{ excerpt }}</span><small>{{ t('Excerpt · expand full message') }}</small></summary>
    <slot v-if="opened" />
  </details>
</template>
<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, ref } from 'vue'
const props = defineProps<{ content: string }>()
const opened = ref(false)
const excerpt = computed(() => `${props.content.replace(/\s+/g, ' ').trim().slice(0, 180)}...`)
</script>
<style scoped>
summary { cursor: pointer; }
summary span { display: block; margin: 6px 0; overflow-wrap: anywhere; }
small { color: var(--c-text-secondary); }
summary:focus-visible { outline: 2px solid var(--c-blue); }
</style>
