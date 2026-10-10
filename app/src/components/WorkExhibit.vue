<template>
  <details class="work-exhibit" @toggle="opened = ($event.currentTarget as HTMLDetailsElement).open">
    <summary>{{ t('Read-only exhibit') }}</summary>
    <p>{{ t('This exhibit cannot run tools, submit answers or grant approval. Use the native controls outside it.') }}</p>
    <iframe v-if="opened" :srcdoc="document" sandbox="" referrerpolicy="no-referrer" :title="t('Read-only work exhibit')" />
  </details>
</template>
<script setup lang="ts">
import { computed, ref } from 'vue'
import { t } from '../i18n.ts'
import { workExhibitDocument } from '../work-exhibit.ts'
const props = defineProps<{ html: string }>()
const opened = ref(false)
const document = computed(() => opened.value ? workExhibitDocument(props.html) : '')
</script>
<style scoped>
.work-exhibit { min-width: 0; margin-block: 14px; }
summary { cursor: pointer; font-weight: 500; }
summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 3px; }
p { margin: 8px 0; color: var(--c-text-secondary); font-size: 12px; line-height: 1.5; }
iframe { display: block; width: 100%; height: clamp(280px, 48dvh, 640px); box-sizing: border-box; border: 1px solid var(--c-border); background: var(--c-bg-card); color-scheme: light; resize: vertical; }
:global(.dark .work-exhibit iframe) { color-scheme: dark; }
</style>
