<script setup lang="ts">
import { ref, watch } from 'vue'
import './alignment-controls.css'
import { t } from '../../i18n.ts'
import { imagePromptExport, parseKeywords, type LibraryImage } from '../../image-library.ts'
const props = defineProps<{ image: LibraryImage; controlled?: boolean }>()
const emit = defineEmits<{ update: [patch: { keywords?: string[]; prompt?: string }] }>()
function update(patch: { keywords?: string[]; prompt?: string }) { if (!props.controlled) Object.assign(props.image, patch); emit('update', patch) }
const feedback = ref('')
watch(() => props.image.id, () => { feedback.value = '' })
let copyTicket = 0
async function copy() {
  const id = props.image.id, ticket = ++copyTicket
  try {
    await navigator.clipboard.writeText(imagePromptExport(props.image))
    if (id === props.image.id && ticket === copyTicket) feedback.value = t('Copied image prompt and keywords.')
  } catch { if (id === props.image.id) feedback.value = t('Copy unavailable. Use export instead.') }
}
function download() {
  const url = URL.createObjectURL(new Blob([imagePromptExport(props.image)], { type: 'application/json' }))
  const a = document.createElement('a'); a.href = url; a.download = `${props.image.file.name}.prompt.json`; a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
</script>
<template>
  <aside class="alignment-content image-prompt-details">
    <h2>{{ t('Prompt keywords') }}</h2>
    <p class="prompt-scope">{{ t('Whole image · separate from local annotations') }}</p>
    <strong class="prompt-image-name">{{ image.file.name }}</strong>
    <p>{{ image.demo ? t('Synthetic demo image and example prompt — not AI generated.') : t('Original prompt unknown. Enter your own notes; no AI inference is performed.') }}</p>
    <div class="keyword-tags"><span v-for="word in image.keywords" :key="word">{{ word }}</span><p v-if="!image.keywords.length">{{ t('No keywords yet.') }}</p></div>
    <label>{{ t('Edit keywords (comma separated)') }}<textarea class="keyword-input" :value="image.keywords.join(', ')" @change="update({ keywords: parseKeywords(($event.target as HTMLTextAreaElement).value) })" /></label>
    <label>{{ t('Full prompt') }}<textarea class="full-prompt" :value="image.prompt" @input="update({ prompt: ($event.target as HTMLTextAreaElement).value })" :placeholder="t('No known prompt. Add a prompt manually.')" /></label>
    <div class="prompt-actions"><button class="btn" @click="copy">{{ t('Copy prompt + keywords') }}</button><button class="btn" @click="download">{{ t('Export prompt + keywords') }}</button></div>
    <p role="status">{{ feedback }}</p>
    <p>{{ t('Local only. Images and prompts stay in this page until it is closed or reloaded.') }}</p>
  </aside>
</template>
<style scoped>
.image-prompt-details{min-width:0;color:var(--c-text)}
h2{margin:0 0 8px;font-size:15px;line-height:20px;font-weight:600}p{font-size:12px;line-height:1.6;color:var(--c-text-secondary)}
.prompt-image-name{overflow-wrap:anywhere;font-size:12px}.keyword-tags{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}
.keyword-tags span{border:1px solid var(--c-border);background:var(--c-bg-soft);padding:4px 7px;font-size:12px;overflow-wrap:anywhere;max-width:100%;box-sizing:border-box}
label{display:grid;gap:6px;font-size:12px;margin:16px 0}textarea{width:100%;box-sizing:border-box;resize:vertical}.keyword-input{min-height:64px}.full-prompt{min-height:140px;line-height:1.6}.prompt-actions{display:flex;flex-wrap:wrap;gap:8px}
</style>
