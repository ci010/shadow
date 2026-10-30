<template>
  <div>
    <div ref="content" class="markdown-body" v-answer-html v-html="html" />
    <Teleport v-for="(block, index) in blocks" :key="index" :to="block.target">
      <CopyIconButton class="code-copy" :value="block.text" :label="t('Copy code block')" />
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { vAnswerHtml } from '../answer-html'
import CopyIconButton from './CopyIconButton.vue'
import { t } from '../i18n.ts'

const props = defineProps<{
  text: string
  renderContent: (text: string) => string
}>()

// Keep parsing, sanitizing and math rendering out of the parent render loop.
const html = computed(() => props.renderContent(props.text))
const content = ref<HTMLElement>()
const blocks = shallowRef<{ target: HTMLElement; text: string }[]>([])
watch([html, content], () => {
  blocks.value = Array.from(content.value?.querySelectorAll('pre') ?? []).flatMap(target => {
    const code = target.querySelector('code')
    if (!code) return []
    target.classList.add('copyable-code')
    return [{ target, text: code.textContent ?? '' }]
  })
}, { flush: 'post' })
</script>

<style scoped>
.markdown-body :deep(> :first-child) { margin-top: 0; }
.markdown-body :deep(> :last-child) { margin-bottom: 0; }
:deep(.copyable-code) { position: relative; padding-right: 44px !important; }
:deep(.code-copy) { position: absolute; top: 4px; right: 4px; opacity: 0; pointer-events: none; }
:deep(.copyable-code:hover .code-copy), :deep(.copyable-code:focus-within .code-copy) { opacity: 1; pointer-events: auto; }
@media (hover: none) { :deep(.code-copy) { opacity: 1; pointer-events: auto; } }
</style>
