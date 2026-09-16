<template>
  <div class="file-modal-backdrop" :class="{ fullscreen, inline }" @click.self="$emit('close')" @keydown.esc.stop="$emit('close')">
    <div class="file-modal" :class="{ fullscreen, inline }" :role="inline ? 'region' : 'dialog'" :aria-modal="inline ? undefined : true" :aria-label="`Preview ${entry.name}`">
      <div class="file-modal-header">
        <HoverInfo :text="path" v-slot="{ triggerProps }"><span v-bind="triggerProps" class="file-modal-title" tabindex="0">{{ inline ? path : entry.name }}</span></HoverInfo>
        <div class="file-modal-actions">
          <label v-if="textMode" class="file-encoding-control">Encoding
            <select v-model="encoding" aria-label="Text encoding" @change="loadText">
              <option v-for="option in textEncodings" :key="option.value" :value="option.value">{{ option.label }}</option>
            </select>
          </label>
          <button v-if="isMarkdown || isMemoryEvents || kind === 'html'" class="file-modal-btn" :aria-pressed="sourceView" @click="sourceView = !sourceView">{{ sourceView ? 'Preview' : 'Source' }}</button>
          <HoverInfo v-if="kind === 'html' && !sourceView" text="Reload preview" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="file-modal-btn" aria-label="Reload preview" @click="reloadFrame"><span class="i-lucide-refresh-cw w-4 h-4" aria-hidden="true" /></button></HoverInfo>
          <HoverInfo v-if="!inline" :text="fullscreen ? 'Exit fullscreen' : 'Fullscreen'" v-slot="{ triggerProps }">
          <button
            class="file-modal-btn"
            v-bind="triggerProps"
            @click="fullscreen = !fullscreen"
            :aria-label="fullscreen ? 'Exit fullscreen' : 'Fullscreen'"
          ><span class="w-4 h-4" :class="fullscreen ? 'i-lucide-minimize' : 'i-lucide-maximize'" aria-hidden="true" /></button>
          </HoverInfo>
          <a class="file-modal-btn" :href="raw" target="_blank" rel="noopener noreferrer">Open raw</a>
          <HoverInfo v-if="!inline" text="Close file preview" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="file-modal-btn" aria-label="Close file preview" @click="$emit('close')"><span class="i-lucide-x w-4 h-4" aria-hidden="true" /></button></HoverInfo>
        </div>
      </div>
      <div class="file-modal-body">
        <ImageAnnotationPreview v-if="kind === 'image'" :key="`image:${raw}`" :src="raw" :name="entry.name"
          :source-key="JSON.stringify([apiBase, sessionId, projectId, path])" :context-key="contextKey"
          :active="active" :editable="canQuote" :keyboard-active="selectionActive"
          @image-context="emit('image-context', $event)" @image-busy="emit('image-busy', $event)" />
        <video v-else-if="kind === 'video' && active" :key="`video:${raw}`" :src="raw" class="file-modal-media" controls autoplay />
        <audio v-else-if="kind === 'audio' && active" :key="`audio:${raw}`" :src="raw" controls class="file-modal-audio" />
        <iframe
          v-else-if="kind === 'html' && active && !sourceView"
          :key="frameNonce"
          :src="staticSrc"
          class="file-modal-frame"
          sandbox="allow-scripts allow-forms allow-popups"
          referrerpolicy="no-referrer"
          :title="entry.name"
        ></iframe>
        <iframe v-else-if="kind === 'pdf' && active" :key="`pdf:${raw}`" :src="raw" :title="entry.name" class="file-modal-frame"></iframe>
        <div v-else-if="textMode" class="file-modal-text-wrap">
          <p v-if="loaded && encodingWarning" class="file-encoding-warning" role="status">{{ encodingWarning }}</p>
          <div v-if="loading" class="file-modal-note">Loading…</div>
          <div v-else-if="error" class="file-modal-note" role="alert">{{ error }} <button class="file-modal-btn" @click="loadText">Retry</button></div>
          <div v-else-if="binary" class="file-modal-note">This file contains binary data. Use Open raw to download it.</div>
          <div v-else-if="isMemoryEvents && !sourceView" ref="selectionRoot" class="file-memory-events" role="list" aria-label="Memory events">
            <MemoryEventRecord v-for="record in memoryRecords" :key="record.start" :record="record" />
          </div>
          <article v-else-if="isMarkdown && !sourceView" ref="selectionRoot" class="file-markdown" aria-label="Markdown preview">
            <div v-for="(block, index) in renderedMarkdown" :key="index" class="file-source-block"
              :data-source-start="block.start" :data-source-end="block.end" :data-source-provenance="block.provenance" v-html="block.html" />
          </article>
          <pre v-else ref="selectionRoot" class="file-modal-text"><FileHighlightText :key="selectionKey" ref="highlight" :source="textContent" :path="path" :active="active && loaded && !loading && !binary" @error="highlightError = $event" /></pre>
          <div v-if="highlightError && ((!isMarkdown && !isMemoryEvents) || sourceView)" class="file-modal-note file-highlight-notice" role="status">{{ highlightError }} <button class="file-modal-btn" @click="highlight?.retry()">Retry</button></div>
          <div v-if="truncated" class="file-modal-note">Preview truncated — use “Open raw” for the full file.</div>
        </div>
        <div v-else class="file-modal-note">
          No inline preview available.
          <a :href="raw" target="_blank" rel="noopener noreferrer">Download</a>.
        </div>
        <SelectionMenu v-if="selectionEnabled" :key="selectionKey" :container="selectionRoot" :active="selectionEnabled" :can-quote="canQuote" @quote="quoteSelection" />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import DOMPurify from 'dompurify'
import SelectionMenu from '../SelectionMenu.vue'
import HoverInfo from '../HoverInfo.vue'
import FileHighlightText from './FileHighlightText.vue'
import MemoryEventRecord from './MemoryEventRecord.vue'
import ImageAnnotationPreview from './ImageAnnotationPreview.vue'
import type { ImageContextBusy, ImageContextUpdate } from '../../image-context.ts'
import { textEncodings, type TextEncoding } from '../../../../src/execution/filesystem/text-encoding.ts'
import { isMemoryEventFile, parseMemoryEvents } from '../../memory-events.ts'
import { fileMarkdownUrl, formatFileQuote, markdownSelectionLines, markdownSourceBlocks, plainSelectionLines, renderedSelectionLines } from '../../file-selection.ts'
import {
  type FileEntry,
  fileKind,
  joinPath,
  useSessionFiles,
} from '../../composables/useSessionFiles'

const props = withDefaults(defineProps<{
  apiBase: string
  sessionId: string
  projectId?: string
  dir: string
  entry: FileEntry
  inline?: boolean
  active?: boolean
  selectionActive?: boolean
  canQuote?: boolean
  contextKey?: string
}>(), { active: true, selectionActive: false, canQuote: false, contextKey: '' })

const emit = defineEmits<{ close: []; quote: [text: string]; 'image-context': [update: ImageContextUpdate]; 'image-busy': [update: ImageContextBusy] }>()

const files = computed(() => useSessionFiles(props.apiBase, props.projectId))

const path = computed(() => joinPath(props.dir, props.entry.name))
const kind = computed(() => fileKind(props.entry.ext))
const isMarkdown = computed(() => ['.md', '.markdown'].includes(props.entry.ext.toLowerCase()))
const isMemoryEvents = computed(() => isMemoryEventFile(path.value))
const sourceView = ref(false)
const textMode = computed(() => kind.value === 'text' || (kind.value === 'html' && sourceView.value))
const raw = computed(() => files.value.rawUrl(props.sessionId, path.value))
const staticSrc = computed(() => files.value.staticUrl(props.sessionId, path.value))

// Bumping this recreates the preview iframe, forcing a fresh reload.
const frameNonce = ref(0)
function reloadFrame(): void {
  frameNonce.value++
}

// Whether the modal fills the whole viewport.
const fullscreen = ref(false)

const textContent = ref('')
const sourcePath = ref<string>()
const encoding = ref<TextEncoding>('auto')
const encodingWarning = ref('')
const truncated = ref(false)
const memoryRecords = computed(() => isMemoryEvents.value ? parseMemoryEvents(textContent.value, truncated.value) : [])
const loading = ref(false)
const error = ref('')
const binary = ref(false)
const loaded = ref(false)
const highlight = ref<InstanceType<typeof FileHighlightText>>()
const highlightError = ref('')
const selectionRoot = ref<HTMLElement>()
const selectionEnabled = computed(() => props.active && props.selectionActive && textMode.value
  && loaded.value && !loading.value && !error.value && !binary.value && !!textContent.value.trim())
const selectionKey = computed(() => JSON.stringify([props.apiBase, props.sessionId, props.projectId, path.value, sourceView.value, frameNonce.value, encoding.value]))
function quoteSelection(text: string, range: Range): void {
  if (!selectionEnabled.value || !props.canQuote || !selectionRoot.value || !text.trim()) return
  const lines = isMemoryEvents.value && !sourceView.value
    ? renderedSelectionLines(selectionRoot.value, range, memoryRecords.value)
    : isMarkdown.value && !sourceView.value
      ? markdownSelectionLines(selectionRoot.value, range, renderedMarkdown.value)
      : plainSelectionLines(selectionRoot.value, range, textContent.value)
  if (lines) emit('quote', formatFileQuote(sourcePath.value ?? path.value, text, lines, truncated.value))
}
const renderedMarkdown = computed(() => markdownSourceBlocks(textContent.value).map(block => ({ ...block, html: sanitizeMarkdown(block.html) })))
function sanitizeMarkdown(html: string): string {
  const fragment = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true }, RETURN_DOM_FRAGMENT: true,
    FORBID_TAGS: ['style', 'form', 'iframe'],
    FORBID_ATTR: ['style', 'srcset'],
    SANITIZE_NAMED_PROPS: true,
  })
  const root = new URL(files.value.staticUrl(props.sessionId, ''))
  for (const element of fragment.querySelectorAll('a[href], img[src]')) {
    const attribute = element.tagName === 'A' ? 'href' : 'src'
    const value = element.getAttribute(attribute)!
    const url = fileMarkdownUrl(value, attribute, staticSrc.value, root.href)
    if (!url) {
      element.removeAttribute(attribute)
      continue
    }
    element.setAttribute(attribute, url)
    if (attribute === 'href') {
      element.setAttribute('target', '_blank')
      element.setAttribute('rel', 'noopener noreferrer')
    } else element.setAttribute('loading', 'lazy')
  }
  const container = document.createElement('div')
  container.append(fragment)
  return container.innerHTML
}
let request: AbortController | undefined

async function loadText(): Promise<void> {
  request?.abort()
  request = undefined
  loading.value = false
  textContent.value = ''
  sourcePath.value = undefined
  encodingWarning.value = ''
  error.value = ''
  truncated.value = false
  binary.value = false
  loaded.value = false
  highlightError.value = ''
  if (!textMode.value || !props.active || !(props.projectId || props.sessionId)) return
  const controller = new AbortController()
  request = controller
  loading.value = true
  try {
    const p = await files.value.preview(props.sessionId, path.value, 65536, controller.signal, encoding.value)
    if (controller.signal.aborted) return
    binary.value = p.binary
    encodingWarning.value = p.encodingWarning ?? ''
    if (!p.binary && p.content != null) {
      textContent.value = p.content
      sourcePath.value = p.sourcePath
      truncated.value = !!p.truncated
    }
    loaded.value = true
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load preview. Retry.'
  } finally {
    if (request === controller) { request = undefined; loading.value = false }
  }
}

watch(() => [props.apiBase, props.sessionId, props.projectId, path.value, kind.value], () => {
  encoding.value = 'auto'
  loaded.value = false
  sourceView.value = false
  frameNonce.value++
  void loadText()
}, { immediate: true })
watch(() => props.active, active => {
  if (active && !loaded.value) void loadText()
  else if (!active) { request?.abort(); request = undefined; loading.value = false }
})
watch(sourceView, () => {
  if (kind.value === 'html') void loadText()
})
onUnmounted(() => request?.abort())
</script>

<style scoped>
.file-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 60;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 2rem;
  backdrop-filter: blur(2px);
}

.file-modal {
  display: flex;
  flex-direction: column;
  max-width: min(1100px, 92vw);
  max-height: 88vh;
  width: 100%;
  background: var(--c-bg-card);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-overlay);
  overflow: hidden;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.35);
}

/* Fullscreen: fill the whole viewport. */
.file-modal-backdrop.fullscreen {
  padding: 0;
}

.file-modal.fullscreen {
  max-width: 100vw;
  max-height: 100vh;
  width: 100vw;
  height: 100vh;
  border: none;
  border-radius: 0;
}

.file-modal.fullscreen .file-modal-media {
  max-height: calc(100vh - 4rem);
}

.file-modal.fullscreen .file-modal-frame {
  height: calc(100vh - 3.2rem);
}

.file-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.6rem 0.9rem;
  border-bottom: 1px solid var(--c-border);
  background: var(--c-bg-muted);
}

.file-modal-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--c-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.file-modal-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  max-width: 100%;
  flex-shrink: 0;
}
.file-encoding-control { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: 12px; color: var(--c-text-secondary); }
.file-encoding-control select { max-width: 180px; min-height: 32px; padding: 4px 6px; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); font: inherit; }
.file-encoding-control select:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.file-encoding-warning { margin: 0 0 12px; color: var(--c-warn); font-size: 12px; line-height: 1.5; overflow-wrap: anywhere; }
.file-modal-backdrop.inline { position: relative; inset: auto; z-index: auto; flex: 1; min-width: 0; min-height: 0; padding: 0; background: transparent; backdrop-filter: none; }
.file-modal.inline { max-width: none; max-height: none; height: 100%; border: 0; border-radius: 0; box-shadow: none; background: var(--c-bg); }
.inline .file-modal-header { gap: 8px; flex-wrap: wrap; padding: 6px 16px; background: transparent; }
.inline .file-modal-title { min-width: 0; flex: 1; font-size: 12px; font-weight: 400; color: var(--c-text-secondary); }
.inline .file-modal-body {
  align-items: flex-start;
  padding: 20px 24px calc(var(--composer-height, 0px) + 48px);
  scroll-padding-bottom: calc(var(--composer-height, 0px) + 48px);
  background: transparent;
  overscroll-behavior: contain;
}
.inline .file-modal-text { padding: 0; background: transparent; border-radius: 0; font-size: 13px; line-height: 1.65; }
/* Keep the final line inside the content box so scrollable bottom padding follows it. */
.inline .file-modal-text-wrap { align-self: flex-start; }
.inline .file-modal-btn { border-color: transparent; background: transparent; color: var(--c-text-secondary); }
.inline .file-modal-btn:hover { border-color: transparent; background: var(--c-bg-muted); color: var(--c-text); }
.inline .file-modal-media { max-width: 100%; max-height: 100%; }
.inline .file-modal-frame { height: 100%; min-height: 280px; }

.file-modal-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-height: 32px;
  font-size: 0.75rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-control);
  background: var(--c-bg-card);
  color: var(--c-text);
  cursor: pointer;
  text-decoration: none;
  line-height: 1.4;
}

.file-modal-btn:hover {
  border-color: var(--c-primary, #6366f1);
}
.file-modal-btn:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }

.file-modal-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  padding: 1rem;
  background: var(--c-bg-muted);
}

.file-modal-media {
  max-width: 100%;
  max-height: calc(88vh - 4rem);
  object-fit: contain;
  border-radius: var(--radius-control);
}

.file-modal-audio {
  width: 80%;
}

.file-modal-frame {
  width: 100%;
  height: calc(88vh - 4rem);
  border: none;
  background: #fff;
}

.file-modal-text-wrap {
  align-self: stretch;
  width: 100%;
}

.file-modal-text {
  margin: 0;
  padding: 0.75rem 1rem;
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.75rem;
  line-height: 1.55;
  color: var(--c-text);
  white-space: pre-wrap;
  word-break: break-word;
  background: var(--c-bg-card);
  border-radius: var(--radius-control);
}

.file-memory-events { box-sizing: border-box; container: memory-events / inline-size; max-width: 88ch; margin: 0 auto; padding: 12px 16px 32px; color: var(--c-text); }
.file-markdown { box-sizing: border-box; max-width: 75ch; margin: 0 auto; padding: 12px 16px 32px; color: var(--c-text); font-size: 16px; line-height: 1.7; overflow-wrap: anywhere; }
.file-source-block { display: contents; }
.file-markdown :deep(h1), .file-markdown :deep(h2), .file-markdown :deep(h3), .file-markdown :deep(h4), .file-markdown :deep(h5), .file-markdown :deep(h6) { font-weight: 600; line-height: 1.3; margin: 1.5em 0 .65em; }
.file-markdown :deep(h1) { font-size: 1.75em; }
.file-markdown :deep(h2) { font-size: 1.4em; }
.file-markdown :deep(h3) { font-size: 1.15em; }
.file-markdown :deep(.file-source-block:first-child > :first-child) { margin-top: 0; }
.file-markdown :deep(p), .file-markdown :deep(ul), .file-markdown :deep(ol) { margin: 0 0 1em; }
.file-markdown :deep(ul) { list-style: disc; padding-left: 1.5em; }
.file-markdown :deep(ol) { list-style: decimal; padding-left: 1.5em; }
.file-markdown :deep(a[href]) { color: var(--c-blue); text-decoration: underline; }
.file-markdown :deep(code) { font-family: 'IBM Plex Mono', ui-monospace, monospace; font-size: .85em; padding: .15em .3em; background: var(--c-bg-card); border-radius: var(--radius-sm); }
.file-markdown :deep(pre) { max-width: 100%; overflow: auto; padding: 16px; background: var(--c-bg-card); border-radius: var(--radius-control); line-height: 1.55; }
.file-markdown :deep(pre code) { padding: 0; white-space: pre; }
.file-markdown :deep(blockquote) { margin: 1em 0; padding-left: 16px; border-left: 1px solid var(--c-border); color: var(--c-text-secondary); }
.file-markdown :deep(table) { display: block; max-width: 100%; overflow: auto; border-collapse: collapse; margin: 1em 0; }
.file-markdown :deep(th), .file-markdown :deep(td) { padding: 8px 12px; border: 1px solid var(--c-border); text-align: left; }
.file-markdown :deep(img) { max-width: 100%; height: auto; }
.file-markdown :deep(hr) { margin: 24px 0; border: 0; border-top: 1px solid var(--c-border); }

.file-modal-note {
  padding: 0.6rem 1rem;
  font-size: 0.75rem;
  color: var(--c-text-muted);
  text-align: center;
}
</style>
