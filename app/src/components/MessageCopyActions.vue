<template>
  <div class="message-copy-actions" :aria-label="t('Copy')">
    <CopyIconButton :value="text" :label="t('Copy Markdown')" />
    <CopyIconButton :get-value="getHtml" :invalidation-source="htmlSource" :label="t('Copy HTML')" icon="i-lucide-code-xml" />
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import CopyIconButton from './CopyIconButton.vue'
const props = defineProps<{ text: string; renderContent: (text: string) => string }>()
// Watch inputs, never the rendered output: clipboard evaluation stays in the click turn.
const htmlSource = () => [props.text, props.renderContent] as const
const getHtml = () => props.renderContent(props.text)
</script>

<style scoped>
.message-copy-actions { display: flex; align-items: center; gap: 2px; }
</style>
