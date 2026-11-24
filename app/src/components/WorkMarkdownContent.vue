<template>
  <MarkdownContent class="work-markdown prose" :text="text" :render-content="renderMarkdown" />
</template>

<script setup lang="ts">
import DOMPurify from 'dompurify'
import { createMarkdown } from '../markdown.ts'
import MarkdownContent from './MarkdownContent.vue'

defineProps<{ text: string }>()
const markdown = createMarkdown({ html: false, breaks: false, math: false })
// Work can originate from external intake. Do not fetch remote images upon reading it.
function renderMarkdown(text: string): string {
  return DOMPurify.sanitize(markdown.render(text), { FORBID_TAGS: ['img'] })
}
</script>

<style scoped>
.work-markdown { max-width: 65ch; overflow-wrap: anywhere; color: var(--c-text-body); }
</style>
