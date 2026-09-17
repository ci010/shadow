<template>
  <video v-if="stream || kind === 'video'" ref="video" :src="stream ? undefined : url" :muted="!!stream" :controls="!stream" playsinline :aria-label="label" />
  <audio v-else-if="kind === 'audio'" :src="url" controls :aria-label="label" />
  <img v-else-if="kind === 'image'" :src="url" :alt="label" />
  <pre v-else-if="kind === 'text'">{{ text }}</pre>
  <p v-else>Preview unavailable for this format. Save the artifact to open it in a compatible application.</p>
</template>

<script setup lang="ts">
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { playableMime } from '../../io/execution.ts'
const props = defineProps<{ stream?: MediaStream; mime?: string; url?: string; text?: string; label: string }>()
const kind = computed(() => playableMime(props.mime ?? ''))
const video = ref<HTMLVideoElement>()
watch([video, () => props.stream], () => {
  if (video.value) {
    video.value.srcObject = props.stream ?? null
    if (props.stream) void video.value.play().catch(() => {})
  }
}, { flush: 'post' })
onBeforeUnmount(() => { if (video.value) video.value.srcObject = null })
</script>

<style scoped>
video, img { width: 100%; max-height: 280px; object-fit: contain; background: var(--c-bg-muted); }
audio { width: 100%; }
pre { max-height: 180px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
p { color: var(--c-text-secondary); }
</style>
