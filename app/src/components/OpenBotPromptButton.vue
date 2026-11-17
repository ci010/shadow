<template>
  <button v-if="documents" class="btn btn-sm" :disabled="loading || !revision" @click="open">{{ t('Open deployed BOT.md in workspace') }}</button>
  <p v-if="error" role="alert">{{ error }}</p>
</template>
<script setup lang="ts">
import { inject, ref, watch, onBeforeUnmount } from 'vue'
import { PromptDocumentsKey } from '../prompt-documents.ts'
import { apiUrl } from '../api-url.ts'
import { t } from '../i18n.ts'
const props = defineProps<{ apiBase: string; projectId: string; botId: string; revision: string }>()
const documents = inject(PromptDocumentsKey, undefined)
const loading = ref(false), error = ref('')
let request: AbortController | undefined
watch(() => [props.apiBase, props.projectId, props.botId, props.revision], () => { request?.abort(); loading.value = false; error.value = '' })
onBeforeUnmount(() => request?.abort())
async function open() {
  request?.abort()
  const current = request = new AbortController()
  loading.value = true; error.value = ''
  try {
    const response = await fetch(apiUrl(props.apiBase, `/api/bot-package/${encodeURIComponent(props.botId)}/prompt`, { revision: props.revision }), { signal: current.signal })
    if (!response.ok) throw new Error(t('BOT prompt unavailable or deployment changed. Refresh and retry.'))
    const data = await response.json()
    if (current.signal.aborted) return
    if (data.id !== props.botId || data.revision !== props.revision || typeof data.prompt !== 'string') throw new Error(t('BOT prompt unavailable or deployment changed. Refresh and retry.'))
    const source = `BOT.md / ${data.id} / deployed revision ${data.revision}`
    documents?.open(props.projectId, { key: `bot:${data.id}:${data.revision}`, label: `${data.id} / BOT.md`, source,
      prompt: data.prompt, sections: [{ name: source, content: data.prompt, characters: data.prompt.length }] })
  } catch (cause) { if (!current.signal.aborted) error.value = cause instanceof Error ? cause.message : t('BOT deployment status unavailable.') }
  finally { if (request === current) loading.value = false }
}
</script>
