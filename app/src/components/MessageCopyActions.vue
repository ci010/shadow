<template>
  <div class="message-copy-actions" :aria-label="t('Copy')">
    <CopyIconButton :value="text" :label="t('Copy Markdown')" />
    <CopyIconButton :value="html" :label="t('Copy HTML')" icon="i-lucide-code-xml" />
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { t } from '../i18n.ts'
import CopyIconButton from './CopyIconButton.vue'
const props = defineProps<{ text: string; renderContent: (text: string) => string }>()
const html = computed(() => props.renderContent(props.text))
</script>

<style scoped>
.message-copy-actions { display: flex; align-items: center; gap: 2px; margin-left: auto; }
</style>
