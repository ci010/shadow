<template>
  <span>{{ elapsed }} / {{ limit }}</span>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{ startedAt?: string; limit: string }>()
const now = ref(Date.now())
const elapsed = computed(() => {
  const start = Date.parse(props.startedAt ?? '')
  const seconds = Number.isFinite(start) ? Math.floor(Math.max(0, now.value - start) / 1000) : 0
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
})
let timer: ReturnType<typeof setInterval> | undefined
// This component exists only in the starting/recording preview. Its clock does
// not invalidate the request card, other requests, or the execution object.
onMounted(() => { timer = setInterval(() => { now.value = Date.now() }, 1000) })
onUnmounted(() => clearInterval(timer))
</script>
