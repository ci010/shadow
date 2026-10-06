<template>
  <div class="search-results">
    <p v-if="result.heading" class="search-heading">{{ result.heading }}</p>
    <section v-for="(file, fileIndex) in result.files" :key="fileIndex" class="search-file" :aria-label="file.path">
      <header class="search-file-header">
        <span class="search-file-icon" :class="fileIcon(file.path)" aria-hidden="true" />
        <span>{{ file.path }}</span>
      </header>
      <div class="search-lines" tabindex="0" :aria-label="`Matching lines in ${file.path}`">
        <div v-for="(match, index) in file.matches" :key="index" class="search-match">
          <span class="search-line-number" :data-line="match.line" :aria-label="`Line ${match.line}`" />
          <pre class="search-code"><FileHighlightText :key="generation" :source="match.text" :path="file.path" :active="true" @error="setError(fileIndex, index, $event)" /></pre>
        </div>
      </div>
    </section>
    <p v-for="(notice, index) in result.notices" :key="index" class="search-notice">{{ notice }}</p>
    <p v-if="errors.size" class="search-error" role="status">Syntax highlighting is unavailable. Plain text is still available. <button type="button" class="btn btn-sm" @click="retry">Retry</button></p>
  </div>
</template>

<script setup lang="ts">
import { reactive, ref, watch } from 'vue'
import type { ToolSearchResult } from '../tool-search-results.ts'
import { fileIcon } from '../file-icons.ts'
import FileHighlightText from './files/FileHighlightText.vue'

const props = defineProps<{ result: ToolSearchResult }>()
const generation = ref(0)
const errors = reactive(new Set<string>())
function setError(file: number, line: number, message: string): void {
  const key = `${file}:${line}`
  if (message) errors.add(key)
  else errors.delete(key)
}
function retry(): void { errors.clear(); generation.value++ }
watch(() => props.result, retry, { flush: 'sync' })
</script>

<style scoped>
.search-results { white-space: normal; overflow-wrap: anywhere; }
.search-heading { margin: 0 0 8px; color: var(--c-text-secondary); }
.search-file + .search-file { margin-top: 16px; }
.search-file-header { display: flex; align-items: flex-start; gap: 8px; margin-bottom: 4px; color: var(--c-text); }
.search-file-icon { flex: 0 0 16px; width: 16px; height: 16px; margin-top: 2px; }
.search-lines { max-width: 100%; overflow: auto; }
.search-lines:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.search-match { display: flex; min-width: max-content; line-height: 22px; }
.search-line-number { position: sticky; left: 0; flex: 0 0 56px; padding-right: 12px; text-align: right; color: var(--c-text-muted); background: var(--c-bg-muted); user-select: none; }
.search-line-number::before { content: attr(data-line); }
.search-code { margin: 0; padding-right: 8px; white-space: pre; overflow-wrap: normal; tab-size: 4; font: inherit; line-height: inherit; }
.search-notice { margin: 8px 0 0; color: var(--c-text-secondary); }
.search-error { margin: 8px 0 0; color: var(--c-error); }
</style>
