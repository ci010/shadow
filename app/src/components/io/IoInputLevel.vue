<template>
  <meter min="0" max="1" :value="level" />
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref } from 'vue'

const props = defineProps<{ levels?: Map<string, number>; sourceId: string }>()
const level = ref(0)
let timer: ReturnType<typeof setInterval> | undefined
// Capture adapters sample mutable level maps. Refresh only this active meter,
// never the execution ref or the whole request card.
onMounted(() => { timer = setInterval(() => { level.value = props.levels?.get(props.sourceId) ?? 0 }, 250) })
onUnmounted(() => clearInterval(timer))
</script>
