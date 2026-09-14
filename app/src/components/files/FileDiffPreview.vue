<template>
  <section class="file-diff" aria-label="File changes">
    <header class="file-diff-header">
      <div class="file-diff-heading"><span class="file-diff-path">{{ path }}</span><span>{{ diff?.base === 'empty' ? 'New file' : 'HEAD' }} → Working tree</span></div>
      <div class="file-diff-actions">
        <button v-if="diff?.status !== 'deleted'" @click="$emit('open-source')">Open file</button>
        <button :disabled="loading" aria-label="Refresh file diff" @click="loadDiff"><span class="i-lucide-refresh-cw" aria-hidden="true" /></button>
      </div>
    </header>
    <div ref="scroller" class="file-diff-scroll">
      <p v-if="loading" class="diff-notice" role="status">Loading changes...</p>
      <div v-if="error" class="diff-notice error" role="alert">{{ error }} <span v-if="diff">Showing the last loaded diff.</span> <button @click="loadDiff">Retry</button></div>
      <template v-if="diff && !loading">
        <p v-if="diff.originalPath" class="diff-notice">Renamed from {{ diff.originalPath }}</p>
        <p v-if="diff.binary || diff.truncated || !diff.hunks.length" class="diff-notice">{{ diff.notice || (diff.binary ? 'Binary files differ. A text diff is not available.' : diff.truncated ? 'This change exceeds the diff preview limit. Use Git locally to inspect the complete change.' : 'No content differences from HEAD. Git metadata or the staging area may still differ.') }}</p>
        <template v-else>
          <p v-if="diff.notice" class="diff-notice">{{ diff.notice }}</p>
          <div class="diff-columns" aria-hidden="true"><span>HEAD</span><span>Now</span></div>
          <p v-if="highlightError" class="diff-notice error" role="alert">{{ highlightError }} <button @click="highlight">Retry highlighting</button></p>
          <p v-if="quoteError" class="diff-notice error" role="alert">{{ quoteError }}</p>
          <div ref="selectionRoot" class="diff-content">
            <section v-for="(hunk, hunkIndex) in hunks" :key="hunkIndex" class="diff-hunk" :aria-label="`Changes at line ${hunk.newStart}`">
              <div class="diff-hunk-heading">@@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@</div>
              <div v-for="(row, index) in hunk.rows" :key="index" class="diff-row" :class="`diff-${row.kind}`"
                data-diff-row :data-old-line="row.oldLine" :data-new-line="row.newLine">
                <span class="diff-line-number" :data-line="row.oldLine" aria-hidden="true" />
                <span class="diff-line-number" :data-line="row.newLine" aria-hidden="true" />
                <pre class="diff-code"><span v-for="(token, tokenIndex) in highlighted[hunkIndex]?.[index] ?? [{ text: hunk.lines[index] }]" :key="tokenIndex" class="diff-token" :style="{ '--file-token-light': token.light, '--file-token-dark': token.dark }">{{ token.text }}</span>{{ '\n' }}</pre>
              </div>
            </section>
          </div>
        </template>
      </template>
    </div>
    <SelectionMenu v-if="active && selectionActive && selectionRoot" :container="selectionRoot" :active="active && selectionActive" :can-quote="canQuote" @quote="quote" />
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import SelectionMenu from '../SelectionMenu.vue'
import { createGitFilesClient, diffLines, type GitDiff } from '../../git-files.ts'
import { highlightFile, type FileHighlightToken } from '../../file-highlighting.ts'
import { quoteDiffSelection, splitHighlightLines } from '../../git-diff-selection.ts'

const props = defineProps<{ apiBase: string; sessionId: string; projectId?: string; path: string; active: boolean; selectionActive: boolean; canQuote: boolean; revision: number }>()
const emit = defineEmits<{ quote: [text: string]; 'open-source': [] }>()
const diff = shallowRef<GitDiff>()
const hunks = computed(() => diff.value?.hunks.map(hunk => ({ ...hunk, rows: diffLines(hunk) })) ?? [])
const highlighted = shallowRef<FileHighlightToken[][][]>([])
const loading = ref(false)
const error = ref('')
const highlightError = ref('')
const quoteError = ref('')
const selectionRoot = ref<HTMLElement>()
const scroller = ref<HTMLElement>()
let controller: AbortController | undefined
let generation = 0
let pendingDiff: GitDiff | undefined
let pendingTokens: FileHighlightToken[][][] | undefined
let pointerDown = false

function selectionLocked() {
  const selection = window.getSelection()
  return pointerDown || !!(selectionRoot.value && selection && !selection.isCollapsed && selection.rangeCount && selection.getRangeAt(0).intersectsNode(selectionRoot.value))
}
function applyPending() {
  if (!props.active || selectionLocked()) return
  if (pendingDiff) {
    const next = pendingDiff
    pendingDiff = undefined
    if (JSON.stringify(next) !== JSON.stringify(diff.value)) {
      diff.value = next
      highlighted.value = []
      void highlight()
    }
  }
  if (pendingTokens) { highlighted.value = pendingTokens; pendingTokens = undefined }
}
async function highlight() {
  const current = ++generation
  highlightError.value = ''
  pendingTokens = undefined
  if (!diff.value || !props.active) return
  try {
    const tokens = await Promise.all(diff.value.hunks.map(async hunk =>
      splitHighlightLines(await highlightFile(hunk.lines.join('\n'), 'changes.diff'))))
    if (current !== generation || !props.active) return
    pendingTokens = tokens
    applyPending()
  } catch {
    if (current === generation && props.active) highlightError.value = 'Syntax highlighting is unavailable. The plain-text diff remains available.'
  }
}
async function loadDiff() {
  controller?.abort()
  controller = undefined
  if (!props.active) return
  const request = new AbortController()
  controller = request
  loading.value = !diff.value
  try {
    const next = await createGitFilesClient(props.apiBase, props.sessionId, props.projectId).diff(props.path, request.signal)
    if (request.signal.aborted) return
    error.value = ''
    pendingDiff = next
    applyPending()
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load the diff. Retry.'
  } finally {
    if (controller === request) { controller = undefined; loading.value = false }
  }
}
function quote(text: string, range: Range) {
  if (!selectionRoot.value || !props.canQuote) return
  const context = quoteDiffSelection(selectionRoot.value, range, diff.value?.sourcePath ?? props.path, text)
  if (!context) { quoteError.value = 'Select file content to quote its source lines.'; return }
  quoteError.value = ''
  emit('quote', context)
}
function beginSelection(event: PointerEvent) { if (event.target instanceof Node && selectionRoot.value?.contains(event.target)) pointerDown = true }
function finishSelection() { pointerDown = false; applyPending() }
watch(() => [props.apiBase, props.sessionId, props.projectId, props.path], () => {
  controller?.abort()
  generation++
  diff.value = undefined
  highlighted.value = []
  pendingDiff = undefined
  pendingTokens = undefined
  quoteError.value = ''
  error.value = ''
  void loadDiff()
}, { immediate: true })
watch(() => [props.active, props.revision], () => {
  if (props.active) { void loadDiff(); if (!highlighted.value.length) void highlight() }
  else { controller?.abort(); controller = undefined; generation++; pointerDown = false; loading.value = false }
})
onMounted(() => {
  document.addEventListener('selectionchange', applyPending)
  document.addEventListener('pointerdown', beginSelection, true)
  document.addEventListener('pointerup', finishSelection)
  document.addEventListener('pointercancel', finishSelection)
})
onUnmounted(() => {
  controller?.abort()
  generation++
  document.removeEventListener('selectionchange', applyPending)
  document.removeEventListener('pointerdown', beginSelection, true)
  document.removeEventListener('pointerup', finishSelection)
  document.removeEventListener('pointercancel', finishSelection)
})
watch(() => props.active, active => { if (active) void nextTick(applyPending) })
</script>

<style scoped>
.file-diff { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; background: var(--c-bg); color: var(--c-text); }
.file-diff-header { display: flex; align-items: center; justify-content: space-between; flex-shrink: 0; gap: 12px; min-height: 44px; padding: 6px 16px; border-bottom: 1px solid var(--c-border); }
.file-diff-heading { display: flex; align-items: baseline; flex-wrap: wrap; gap: 6px 16px; min-width: 0; font-size: 12px; color: var(--c-text-secondary); }
.file-diff-path { overflow-wrap: anywhere; color: var(--c-text); }
.file-diff-actions { display: flex; align-items: center; flex-shrink: 0; gap: 4px; }
button { display: inline-flex; align-items: center; justify-content: center; min-height: 32px; padding: 6px 8px; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
button > span { width: 16px; height: 16px; }
button:hover { background: var(--c-bg-muted); color: var(--c-text); }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
button:disabled { opacity: .5; cursor: default; }
.file-diff-scroll { flex: 1; min-height: 0; min-width: 0; overflow: auto; padding: 12px 0 calc(var(--composer-height, 0px) + 24px); scroll-padding-bottom: calc(var(--composer-height, 0px) + 24px); overscroll-behavior: contain; }
.diff-content { min-width: 100%; width: max-content; }
.diff-columns { display: flex; gap: 0; color: var(--c-text-secondary); font-size: 10px; }
.diff-columns > span { width: 48px; text-align: right; padding-right: 8px; box-sizing: border-box; }
.diff-hunk { padding-bottom: 20px; }
.diff-hunk-heading { padding: 8px 16px; color: var(--c-blue); background: var(--c-blue-soft, var(--c-bg-soft)); font: 12px/1.6 'IBM Plex Mono', monospace; }
.diff-row { display: grid; grid-template-columns: 48px 48px minmax(0, 1fr); min-height: 22px; }
.diff-added { background: color-mix(in srgb, var(--c-git-added) 13%, transparent); }
.diff-removed { background: color-mix(in srgb, var(--c-git-deleted) 13%, transparent); }
.diff-line-number { padding: 0 8px; color: var(--c-text-secondary); text-align: right; font: 11px/22px 'IBM Plex Mono', monospace; user-select: none; }
.diff-line-number::before { content: attr(data-line); }
.diff-code { margin: 0; padding: 0 20px 0 8px; white-space: pre; font: 13px/22px 'IBM Plex Mono', monospace; color: var(--c-text); tab-size: 4; }
.diff-note .diff-code { color: var(--c-text-secondary); font-style: italic; }
.diff-token { color: var(--file-token-light, var(--c-text)); }
.dark .diff-token { color: var(--file-token-dark, var(--c-text)); }
.diff-notice { margin: 0; padding: 16px 24px; color: var(--c-text-secondary); font-size: 13px; overflow-wrap: anywhere; }
.diff-notice.error { color: var(--c-error); }
@media (max-width: 700px) {
  .diff-row { grid-template-columns: 36px 36px minmax(0, 1fr); }
  .diff-columns > span { width: 36px; }
}
</style>
