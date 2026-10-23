<template>
  <video v-if="stream || kind === 'video'" ref="video" v-mobile-media="resources.native ? url : undefined" :src="stream ? undefined : resources.resolve(url)" :muted="!!stream" :controls="!stream" playsinline :aria-label="label" />
  <audio v-else-if="kind === 'audio'" v-mobile-media="resources.native ? url : undefined" :src="resources.resolve(url)" controls :aria-label="label" />
  <img v-else-if="kind === 'image'" :src="resources.resolve(url)" :alt="label" referrerpolicy="no-referrer" />
  <pre v-else-if="kind === 'text'">{{ text }}</pre>
  <p v-else>{{ t('Preview unavailable for this format. Save the artifact to open it in a compatible application.') }}</p>
</template>

<script setup lang="ts">
import { t } from '../../i18n.ts'
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import { playableMime } from '../../io/execution.ts'
import { useMobileResources, vMobileMedia } from '../../mobile-resources.ts'
const resources = useMobileResources()
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
