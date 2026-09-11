<template>
  <time class="message-time" :datetime="time.dateTime" :title="time.title" :aria-label="time.title">{{ time.label }}</time>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { messageTime } from '../message-history.ts'

const props = defineProps<{ timestamp?: string }>()
const time = computed(() => messageTime(props.timestamp))
</script>

<style scoped>
.message-time {
  margin-left: auto;
  color: var(--c-text-secondary);
  font-size: 0.6rem;
  line-height: 1.4;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
</style>
