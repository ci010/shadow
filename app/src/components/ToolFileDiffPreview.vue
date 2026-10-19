<template>
  <div ref="root" class="tool-file-preview" :aria-busy="loading" @pointerdown="dragging = true">
    <p v-if="loading" class="preview-notice" role="status">{{ t('Loading file diff...') }}</p>
    <p v-else-if="error" class="preview-notice preview-error" role="alert">{{ error }} <button type="button" @click="load">{{ t('Retry') }}</button></p>
    <p v-else-if="!changes.length" class="preview-notice">{{ t('No historical file diff was recorded for this tool call. The original arguments and result are available in Details.') }}</p>
    <section v-for="change in changes" :key="change.id" class="tool-file-diff" :aria-label="t('File diff: {path}', { path: path || change.path })">
      <header class="diff-file-header" :title="change.path">
        <span class="diff-file-icon" :class="fileIcon(path || change.path)" aria-hidden="true" />
        <span class="diff-file-path">{{ path || change.path }}</span>
      </header>
      <p v-if="change.unavailable" class="preview-notice">{{ change.unavailable }}</p>
      <p v-if="highlightErrors[change.id]" class="preview-notice preview-error" role="status">{{ highlightErrors[change.id] }} <button type="button" @click="highlight(change)">{{ t('Retry highlighting') }}</button></p>
      <div v-if="change.hunks.length" class="diff-scroll" tabindex="0" :aria-label="t('Scroll diff for {path}', { path: path || change.path })">
        <div class="diff-content">
          <section v-for="(hunk, hunkIndex) in change.hunks" :key="hunkIndex" class="diff-hunk" :aria-label="t('Changes at line {newStart}', { newStart: hunk.newStart })">
            <div class="diff-hunk-heading">@@ -{{ hunk.oldStart }},{{ hunk.oldLines }} +{{ hunk.newStart }},{{ hunk.newLines }} @@</div>
            <div v-for="(row, rowIndex) in diffLines(hunk)" :key="rowIndex" class="diff-row" :class="`diff-${row.kind}`">
              <span class="diff-line-number" :data-line="row.oldLine" aria-hidden="true" />
              <span class="diff-line-number" :data-line="row.newLine" aria-hidden="true" />
              <span class="diff-marker" :data-marker="row.kind === 'added' ? '+' : row.kind === 'removed' ? '-' : ''" aria-hidden="true" />
              <pre class="diff-code"><span v-for="(token, tokenIndex) in highlighted[change.id]?.[hunkIndex]?.[rowIndex] ?? [{ text: row.text }]" :key="tokenIndex" class="diff-token" :style="{ '--file-token-light': token.light, '--file-token-dark': token.dark }">{{ token.text }}</span>{{ '\n' }}</pre>
            </div>
          </section>
        </div>
      </div>
      <template v-else-if="change.writtenContent !== undefined">
        <p class="preview-notice">{{ t('Written content only; a before/after diff is unavailable.') }}</p>
        <pre class="written-content"><span v-for="(token, index) in highlighted[change.id]?.[0]?.[0] ?? [{ text: change.writtenContent }]" :key="index" class="diff-token" :style="{ '--file-token-light': token.light, '--file-token-dark': token.dark }">{{ token.text }}</span></pre>
      </template>
      <p v-else-if="!change.unavailable" class="preview-notice">{{ t('No content changes.') }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { diffLines } from '../git-files.ts'
import { fileIcon } from '../file-icons.ts'
import { highlightFile, type FileHighlightToken } from '../file-highlighting.ts'
import { highlightDiffHunks, loadToolFileChanges, type ToolFileChange } from '../tool-file-diff.ts'

const props = defineProps<{ apiBase: string; sessionId: string; toolCallId: string; path?: string }>()
const root = ref<HTMLElement>()
const changes = shallowRef<ToolFileChange[]>([])
const highlighted = ref<Record<string, FileHighlightToken[][][]>>({})
const highlightErrors = ref<Record<string, string>>({})
const loading = ref(false)
const error = ref('')
let controller: AbortController | undefined
let ownerDocument: Document | undefined
const dragging = ref(false)
const pending = new Map<string, FileHighlightToken[][][]>()

function applyPending(): void {
  const selection = root.value?.ownerDocument.getSelection()
  if (dragging.value || (root.value && selection && !selection.isCollapsed && selection.rangeCount
    && selection.getRangeAt(0).intersectsNode(root.value))) return
  for (const [id, tokens] of pending) highlighted.value[id] = tokens
  pending.clear()
}
function finishSelection(): void { dragging.value = false; applyPending() }
async function highlight(change: ToolFileChange): Promise<void> {
  const request = controller
  highlightErrors.value[change.id] = ''
  try {
    const tokens = change.hunks.length ? await highlightDiffHunks(change.hunks, change.path)
      : [[await highlightFile(change.writtenContent ?? '', change.path)]]
    if (request && request === controller && !request.signal.aborted) {
      pending.set(change.id, tokens)
      applyPending()
    }
  } catch (error) {
    console.warn('File syntax highlighting failed', change.path, error)
    if (request && request === controller && !request.signal.aborted) {
      highlightErrors.value[change.id] = t('Syntax highlighting is unavailable. The plain-text diff remains available.')
    }
  }
}
async function load(): Promise<void> {
  controller?.abort()
  const request = new AbortController()
  controller = request
  changes.value = []
  highlighted.value = {}
  highlightErrors.value = {}
  pending.clear()
  dragging.value = false
  loading.value = true
  error.value = ''
  try {
    const next = await loadToolFileChanges(props.apiBase, props.sessionId, props.toolCallId, request.signal)
    if (request.signal.aborted) return
    changes.value = next
    for (const change of next) if (change.hunks.length || change.writtenContent !== undefined) void highlight(change)
  } catch (cause) {
    if (!request.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load the recorded file diff. Retry.')
  } finally {
    if (controller === request) loading.value = false
  }
}
watch(() => [props.apiBase, props.sessionId, props.toolCallId], () => { void load() }, { immediate: true })
onMounted(() => {
  ownerDocument = root.value!.ownerDocument
  ownerDocument.addEventListener('selectionchange', applyPending)
  ownerDocument.addEventListener('pointerup', finishSelection)
  ownerDocument.addEventListener('pointercancel', finishSelection)
})
onUnmounted(() => {
  controller?.abort()
  controller = undefined
  pending.clear()
  ownerDocument?.removeEventListener('selectionchange', applyPending)
  ownerDocument?.removeEventListener('pointerup', finishSelection)
  ownerDocument?.removeEventListener('pointercancel', finishSelection)
  ownerDocument = undefined
})
</script>

<style scoped>
.tool-file-preview { min-width: 0; color: var(--c-text); }
.tool-file-diff { margin: 4px 0 12px; min-width: 0; overflow: hidden; border: 1px solid var(--c-border); border-radius: var(--radius-surface); background: var(--c-bg-card); }
.diff-file-header { display: flex; align-items: center; gap: 8px; min-height: 36px; padding: 6px 12px; border-bottom: 1px solid var(--c-border); color: var(--c-text-secondary); }
.diff-file-icon { flex: 0 0 16px; width: 16px; height: 16px; }
.diff-file-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 12px; }
.diff-scroll { max-height: 560px; overflow: auto; overscroll-behavior: contain; }
.diff-scroll:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.diff-content { width: max-content; min-width: 100%; }
.diff-hunk + .diff-hunk { border-top: 1px solid var(--c-border-soft); }
.diff-hunk-heading { padding: 5px 12px; color: var(--c-text-secondary); background: var(--c-bg-soft); font: 11px/20px 'IBM Plex Mono', ui-monospace, monospace; }
.diff-row { display: grid; grid-template-columns: 40px 40px 20px minmax(0, 1fr); min-height: 22px; }
.diff-added { background: color-mix(in srgb, var(--c-git-added) 13%, transparent); }
.diff-removed { background: color-mix(in srgb, var(--c-git-deleted) 13%, transparent); }
.diff-line-number, .diff-marker { color: var(--c-text-secondary); font: 11px/22px 'IBM Plex Mono', ui-monospace, monospace; user-select: none; }
.diff-line-number { padding: 0 6px; text-align: right; }
.diff-line-number::before { content: attr(data-line); }
.diff-marker { text-align: center; }
.diff-marker::before { content: attr(data-marker); }
.diff-added .diff-marker { color: var(--c-git-added); }
.diff-removed .diff-marker { color: var(--c-git-deleted); }
.diff-code { margin: 0; padding: 0 16px 0 4px; white-space: pre; font: 12px/22px 'IBM Plex Mono', ui-monospace, monospace; tab-size: 4; }
.diff-token { color: var(--file-token-light, var(--c-text)); }
.dark .diff-token { color: var(--file-token-dark, var(--c-text)); }
.diff-note .diff-code { color: var(--c-text-secondary); font-style: italic; }
.preview-notice { margin: 0; padding: 10px 12px; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.preview-error { color: var(--c-error); }
button { border: 0; padding: 4px 8px; background: transparent; color: var(--c-blue); font: inherit; cursor: pointer; }
button:hover { background: var(--c-bg-muted); }
.written-content { margin: 0; max-height: 560px; overflow: auto; padding: 10px 12px; font: 12px/22px 'IBM Plex Mono', ui-monospace, monospace; tab-size: 4; }
@media (max-width: 600px) {
  .diff-row { grid-template-columns: 32px 32px 16px minmax(0, 1fr); }
  .diff-line-number { padding: 0 4px; }
}
</style>
