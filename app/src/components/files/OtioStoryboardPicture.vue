<template>
  <div ref="element" class="thumbnail" :data-state="status">
    <canvas ref="canvas" v-show="status === 'ready'" role="img" :aria-label="t('Representative picture')" />
    <span v-if="status !== 'ready'">{{ gap ? t('No picture / gap') : status === 'unavailable' ? (unlinked || t('Picture unavailable')) : t('Loading picture…') }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref, watch } from 'vue'
import { useMobileResources } from '../../mobile-resources.ts'
import { t } from '../../i18n.ts'
import { drawStoryboardPicture, queueStoryboardPicture } from '../../otio-storyboard-picture.ts'
import type { OtioMedium } from '../../otio-review.ts'
const props = defineProps<{ medium: (OtioMedium & { url: string }) | null; seconds: number | null; gap: boolean; active: boolean; unlinked: string }>()
const element = ref<HTMLElement>(), canvas = ref<HTMLCanvasElement>(), visible = ref(false)
const resources = useMobileResources()
const resolved = computed(() => props.active && visible.value && documentVisible.value && props.medium?.kind !== 'audio'
  ? resources.resolve(props.medium?.url) : undefined)
const status = ref<'ready' | 'unavailable' | 'pending'>('pending')
let observer: IntersectionObserver | undefined
const documentVisible = ref(true)
function visibility() { documentVisible.value = !document.hidden }
onMounted(() => {
  visibility()
  document.addEventListener('visibilitychange', visibility)
  observer = new IntersectionObserver(entries => {
    // Native observers may batch several crossings while Vue Flow lays out a node.
    // The last entry is the current state; using the first can strand a visible card.
    visible.value = !!entries.at(-1)?.isIntersecting
  })
  observeCurrent()
})
// Vue Flow retains keyed thumbnails while sources/tasks and clipping ancestors change.
// A fresh observation must admit each new task: a previously delivered `false`
// must not strand it, and an old `true` must not eagerly load a now-clipped card.
let observed: HTMLElement | undefined
function observeCurrent() {
  if (!observer) return
  if (observed) observer.unobserve(observed)
  visible.value = false
  observed = element.value
  if (observed && props.active && documentVisible.value) observer.observe(observed)
}
watch(() => [element.value, props.active, props.medium?.url, props.seconds, documentVisible.value] as const,
  observeCurrent, { flush: 'post' })
onBeforeUnmount(() => { observer?.disconnect(); document.removeEventListener('visibilitychange', visibility) })
watch(() => [props.active, documentVisible.value, visible.value, props.medium?.url, props.medium?.kind, props.seconds, resolved.value] as const,
  ([active, shown, seen, rawUrl, kind, seconds, url], previous, cleanup) => {
    if (!previous || rawUrl !== previous[3] || kind !== previous[4] || seconds !== previous[5]) status.value = 'pending'
    if (!rawUrl || !kind || kind === 'audio' || seconds === null) { status.value = 'unavailable'; return }
    if (!url || !active || !shown || !seen || !canvas.value || status.value !== 'pending') return
    const controller = new AbortController(), target = canvas.value
    cleanup(() => controller.abort())
    queueStoryboardPicture(controller.signal, async () => {
      try {
        await drawStoryboardPicture(target, url, kind, seconds, controller.signal)
        if (!controller.signal.aborted) status.value = 'ready'
      } catch { if (!controller.signal.aborted) status.value = 'unavailable' }
    })
  }, { immediate: true, flush: 'post' })
</script>

<style scoped>
.thumbnail { aspect-ratio: 16 / 9; overflow: hidden; display: grid; place-items: center; background: var(--c-bg-code); color: var(--c-text-on-dark); }
canvas { display: block; width: 100%; }
span { padding: 6px; font-size: 11px; text-align: center; }
</style>
