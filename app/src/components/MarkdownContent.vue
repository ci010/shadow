<template>
  <div v-answer-html v-html="html" />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { vAnswerHtml } from '../answer-html'

const props = defineProps<{
  text: string
  renderContent: (text: string) => string
}>()

// Keep parsing, sanitizing and math rendering out of the parent render loop.
// A composer keystroke must not re-render every historical Markdown message.
// Dependencies read by renderContent (e.g. mobile resource tickets) remain reactive.
const html = computed(() => props.renderContent(props.text))
</script>
