<script setup lang="ts">
import { ref, watch } from 'vue'
import { t } from '../../i18n.ts'
import { imagePromptExport, parseKeywords, type LibraryImage } from '../../image-library.ts'
const props = defineProps<{ image: LibraryImage }>()
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
  <aside class="image-prompt-details">
    <h2>{{ t('Prompt keywords') }}</h2>
    <p class="prompt-scope">{{ t('Whole image · separate from local annotations') }}</p>
    <strong class="prompt-image-name">{{ image.file.name }}</strong>
    <p>{{ image.demo ? t('Synthetic demo image and example prompt — not AI generated.') : t('Original prompt unknown. Enter your own notes; no AI inference is performed.') }}</p>
    <div class="keyword-tags"><span v-for="word in image.keywords" :key="word">{{ word }}</span><p v-if="!image.keywords.length">{{ t('No keywords yet.') }}</p></div>
    <label>{{ t('Edit keywords (comma separated)') }}<textarea class="keyword-input" :value="image.keywords.join(', ')" @change="image.keywords = parseKeywords(($event.target as HTMLTextAreaElement).value)" /></label>
    <label>{{ t('Full prompt') }}<textarea class="full-prompt" v-model="image.prompt" :placeholder="t('No known prompt. Add a prompt manually.')" /></label>
    <div class="prompt-actions"><button class="btn" @click="copy">{{ t('Copy prompt + keywords') }}</button><button class="btn" @click="download">{{ t('Export prompt + keywords') }}</button></div>
    <p role="status">{{ feedback }}</p>
    <p>{{ t('Local only. Images and prompts stay in this page until it is closed or reloaded.') }}</p>
  </aside>
</template>
<style scoped>
.image-prompt-details { border:1px solid var(--c-border);border-radius:16px;padding:20px;position:sticky;top:12px;min-width:0;background:var(--c-bg); }
h2 { margin:0 0 12px;font-size:19px; } p { font-size:12px;line-height:1.6;color:var(--c-text-secondary); } .prompt-image-name { overflow-wrap:anywhere; } .keyword-tags { display:flex;flex-wrap:wrap;gap:8px;margin:18px 0; } .keyword-tags span { border:1px solid #8a78ae66;background:#8a78ae18;border-radius:8px;padding:7px 10px;font-size:13px;overflow-wrap:anywhere;max-width:100%; } label { display:grid;gap:8px;font-size:13px;margin:18px 0; } textarea { width:100%;box-sizing:border-box;resize:vertical;border:1px solid var(--c-border);border-radius:8px;background:var(--c-bg);color:inherit;padding:10px;font:inherit; } .keyword-input { min-height:70px; } .full-prompt { min-height:210px;line-height:1.6; } .prompt-actions { display:flex;flex-wrap:wrap;gap:8px; }
@media(max-width:850px) { .image-prompt-details { position:static; } }
</style>
