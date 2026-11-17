<template>
  <section class="prompt-document">
    <header><h2>{{ document.label }}</h2><p>{{ document.source }}</p>
      <div role="group" :aria-label="t('System prompt format')"><button class="btn btn-sm" :aria-pressed="!raw" @click="raw = false">{{ t('Read') }}</button><button class="btn btn-sm" :aria-pressed="raw" @click="raw = true">{{ t('Raw') }}</button></div>
    </header>
    <div ref="selectionRoot" class="prompt-document-body" tabindex="0">
      <SystemPromptCard :prompt="document.prompt" :sections="document.sections" :raw="raw" />
    </div>
    <SelectionMenu :container="selectionRoot" :active="active" :can-quote="canQuote" @quote="text => $emit('quote', formatPromptQuote(document.source, text))" />
  </section>
</template>
<script setup lang="ts">
import { ref } from 'vue'
import { t } from '../i18n.ts'
import { formatPromptQuote, type PromptDocument } from '../prompt-documents.ts'
import SystemPromptCard from './SystemPromptCard.vue'
import SelectionMenu from './SelectionMenu.vue'
defineProps<{ document: PromptDocument; active: boolean; canQuote: boolean }>()
defineEmits<{ quote: [text: string] }>()
const raw = ref(false)
const selectionRoot = ref<HTMLElement>()
</script>
<style scoped>
.prompt-document { min-height: 0; display: flex; flex-direction: column; flex: 1; background: var(--c-bg-card); }
header { padding: 16px 20px; border-bottom: 1px solid var(--c-border); }
h2 { font-size: 15px; margin: 0; } p { font-size: 12px; color: var(--c-text-secondary); overflow-wrap: anywhere; } header>div { display: flex; gap: 8px; margin-top: 12px; }
.prompt-document-body { overflow: auto; min-height: 0; padding: 20px; }
</style>
