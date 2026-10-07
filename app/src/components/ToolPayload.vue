<template>
  <div class="tool-payload" :class="{ 'payload-box': boxed }">
    <ToolSearchResults v-if="search" :result="search" />
    <pre v-else class="payload-source" :class="{ 'payload-code': filePath || searchResult }"><FileHighlightText v-if="fileLanguage(path) !== 'text'" ref="highlight" :source="source" :path="path" :active="true" :line-numbers="lineNumbers" @error="error = $event" /><template v-else>{{ source }}</template></pre>
    <figure v-for="(image, index) in images" :key="index" class="payload-image">
      <img :src="image" :alt="t('Tool output image {value1}', { value1: index + 1 })" loading="lazy" @error="imageError = true" />
      <figcaption>{{ t('Tool output image') }} {{ index + 1 }}</figcaption>
    </figure>
    <p v-if="imageError" class="payload-error" role="status">{{ t('An image could not be displayed.') }}</p>
    <p v-if="error" class="payload-error" role="status">{{ error }} <button type="button" class="btn btn-sm" @click="highlight?.retry()">{{ t('Retry') }}</button></p>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, ref, watch } from 'vue'
import { toolPayloadPath } from '../tool-activity.ts'
import { fileLanguage } from '../file-highlighting.ts'
import { parseToolSearchResult } from '../tool-search-results.ts'
import FileHighlightText from './files/FileHighlightText.vue'
import ToolSearchResults from './ToolSearchResults.vue'

const props = defineProps<{ source: string; images?: string[]; filePath?: string; lineNumbers?: boolean; searchResult?: boolean; boxed?: boolean }>()
const imageError = ref(false)
watch(() => props.images, () => { imageError.value = false })
const path = computed(() => props.filePath || toolPayloadPath(props.source))
const search = computed(() => props.searchResult ? parseToolSearchResult(props.source) : undefined)
const highlight = ref<InstanceType<typeof FileHighlightText>>()
const error = ref('')
watch(() => [props.source, props.filePath, props.lineNumbers], () => { error.value = '' }, { flush: 'sync' })
</script>

<style scoped>
.payload-box { margin: 4px 0 8px; padding: 10px 12px; max-height: 300px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.6 'IBM Plex Mono', ui-monospace, monospace; background: var(--c-bg-muted); border-radius: var(--radius-control); color: var(--c-text-secondary); }
.payload-source { margin: 0; white-space: inherit; overflow-wrap: inherit; font: inherit; }
.payload-code { white-space: pre; overflow-wrap: normal; tab-size: 4; }
.payload-image { margin: 12px 0 0; }
.payload-image img { display: block; max-width: 100%; max-height: 600px; object-fit: contain; }
.payload-image figcaption { margin-top: 4px; font: 12px/1.5 system-ui, sans-serif; color: var(--c-text-secondary); }
.payload-error { margin: 8px 0 0; white-space: normal; color: var(--c-error); font: 12px/1.5 system-ui, sans-serif; }
</style>
