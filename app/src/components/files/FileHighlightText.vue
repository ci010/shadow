<template>
  <span ref="root" class="file-highlight-content" @pointerdown="startDrag"><span v-for="(token, index) in tokens" :key="index" class="file-syntax-token" :style="{ '--file-token-light': token.light, '--file-token-dark': token.dark }">{{ token.text }}</span></span>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { highlightFile, type FileHighlightToken } from '../../file-highlighting.ts'

const props = defineProps<{ source: string; path: string; active: boolean; lineNumbers?: boolean }>()
const emit = defineEmits<{ error: [message: string] }>()
const root = ref<HTMLElement>()
const tokens = shallowRef<FileHighlightToken[]>([{ text: props.source }])
let pending: FileHighlightToken[] | undefined
let generation = 0
let dragging = false

function startDrag(): void {
  dragging = true
}

function selectionLocked(): boolean {
  if (dragging) return true
  const selection = root.value?.ownerDocument.getSelection()
  return !!(root.value && selection && !selection.isCollapsed && selection.rangeCount
    && selection.getRangeAt(0).intersectsNode(root.value))
}
function applyPending(): void {
  if (!props.active || !pending || selectionLocked()) return
  tokens.value = pending
  pending = undefined
}
async function retry(): Promise<void> {
  const current = ++generation
  pending = undefined
  emit('error', '')
  if (!props.active) return
  try {
    const result = await highlightFile(props.source, props.path, { lineNumbers: props.lineNumbers })
    if (current !== generation || !props.active) return
    pending = result
    applyPending()
  } catch (error) {
    console.warn('File syntax highlighting failed', props.path, error)
    if (current === generation && props.active) emit('error', 'Syntax highlighting is unavailable. Plain text is still available.')
  }
}
watch(() => [props.source, props.path, props.lineNumbers], () => {
  tokens.value = [{ text: props.source }]
  void retry()
}, { immediate: true })
watch(() => props.active, active => {
  if (active) void retry()
  else { generation++; pending = undefined; dragging = false }
})
onMounted(() => {
  watch(() => props.active, (active, _, onCleanup) => {
    const document = root.value?.ownerDocument
    if (!active || !document) return
    const finishDrag = () => { dragging = false; applyPending() }
    document.addEventListener('pointerup', finishDrag)
    document.addEventListener('pointercancel', finishDrag)
    document.addEventListener('selectionchange', applyPending)
    onCleanup(() => {
      document.removeEventListener('pointerup', finishDrag)
      document.removeEventListener('pointercancel', finishDrag)
      document.removeEventListener('selectionchange', applyPending)
    })
  }, { immediate: true })
})
onUnmounted(() => { generation++; pending = undefined })
defineExpose({ retry })
</script>

<style scoped>
.file-syntax-token { color: var(--file-token-light, var(--c-text)); }
.dark .file-syntax-token { color: var(--file-token-dark, var(--c-text)); }
</style>
