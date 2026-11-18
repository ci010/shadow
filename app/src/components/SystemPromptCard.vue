<template>
  <div
    class="flex flex-col min-w-0 min-h-0"
    :class="[embedded ? 'prompt-embedded' : 'rounded-md border border-default bg-surface overflow-hidden', { 'card-collapsed': collapsible && collapsed }]"
  >
    <div
      v-if="!embedded"
      class="px-4 py-3 border-b border-default flex-shrink-0 flex items-center justify-between"
      :class="{ 'card-header-toggle': collapsible }"
      @click="collapsible && (collapsed = !collapsed)"
    >
      <div class="text-xs text-ink/50 font-600 uppercase tracking-widest flex items-center gap-2">
        <span v-if="collapsible" class="card-chevron" v-html="collapsed ? '&#9654;' : '&#9660;'" />
        {{ title || t('System Prompt') }}
        <span v-if="prompt && showTokenEstimate" class="font-400 normal-case tracking-normal text-ink/35">
          (~{{ Math.round(prompt.length / 4) }} {{ t('tokens)') }}
        </span>
      </div>
      <button
        v-if="prompt"
        class="copy-btn"
        :class="{ copied }"
        :disabled="copyBusy"
        @click.stop="copy"
      >
        <span class="w-3 h-3" :class="copied ? 'i-lucide-check' : 'i-lucide-copy'" aria-hidden="true" />
        {{ copied ? t('Copied!') : t('Copy') }}
      </button>
    </div>
    <p v-if="copyError && !embedded" class="copy-error" role="alert">{{ copyError }}</p>
    <template v-if="!collapsible || !collapsed">
      <div v-if="!prompt && emptyMessage" class="prompt-empty flex-1 flex items-center justify-center text-ink/40 text-sm px-4">
        {{ emptyMessage }}
      </div>
      <div v-if="searchable && prompt" class="context-search" role="search" :aria-label="t('System prompt')">
        <label class="context-search-input">
          <span class="i-lucide-search" aria-hidden="true" />
          <input v-model="query" type="search" :aria-label="t('Search this preview')" :placeholder="t('Search this preview')" autocomplete="off" @keydown="searchKeydown" />
        </label>
        <span class="context-search-status" role="status">{{ !query.trim() ? '' : search.count ? t('Match {current} of {total}', { current: formatNumber(activeHit + 1), total: formatNumber(search.count) }) : t('No matching entries.') }}</span>
        <div class="context-search-actions">
          <HoverInfo v-for="direction in directions" :key="direction.step" :text="direction.label()" v-slot="{ triggerProps }">
            <button v-bind="triggerProps" type="button" class="btn btn-sm" :aria-label="direction.label()" :disabled="!search.count" @click="moveHit(direction.step)">
              <span :class="direction.icon" aria-hidden="true" />
            </button>
          </HoverInfo>
        </div>
      </div>
      <div v-if="prompt" ref="searchRoot" :class="embedded ? 'prompt-content' : 'flex-1 overflow-y-auto px-4 py-3 min-h-0'">
        <pre v-if="raw" class="system-prompt-raw"><template v-for="(part, index) in search.raw" :key="index"><mark v-if="part.hit !== undefined" :data-context-hit="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></pre>
        <div v-else-if="validatedSections.length" class="prompt-sections">
          <component :is="searchable ? 'details' : 'section'" v-for="(section, index) in search.sections" :key="index" class="prompt-section" :open="searchable || undefined">
            <component :is="searchable ? 'summary' : 'header'" class="prompt-section-heading">
              <template v-for="(part, i) in section.heading" :key="i"><mark v-if="part.hit !== undefined" :data-context-hit="part.hit">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template>
            </component>
            <div class="prose max-w-none system-prompt-content" v-markdown-link-hints v-html="section.body" />
          </component>
        </div>
        <template v-else>
          <p v-if="showProvenance" class="prompt-provenance-note">{{ t('Source metadata unavailable; showing exact prompt without inferred sources.') }}</p>
          <div class="prose max-w-none system-prompt-content" v-markdown-link-hints v-html="search.body" />
        </template>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { vMarkdownLinkHints } from '../markdown-link-hints'
import { createMarkdown } from '../markdown.ts'
import { formatNumber, t } from '../i18n.ts'
import { computed, ref, watch } from 'vue'
import { contextPreviewHighlighter } from '../context-preview-search.ts'
import HoverInfo from './HoverInfo.vue'
import { promptSections } from '../prompt-sections.ts'
import DOMPurify from 'dompurify'
import { useMobileResources } from '../mobile-resources.ts'
const mobileResources = useMobileResources()
import { useTextCopy } from '../composables/useTextCopy.ts'

// Prompt HTML is documentation, not executable markup. Disable both block and
// inline HTML tokenization so an unclosed raw-text tag cannot consume the tail.
const marked = createMarkdown({ html: false })

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

const KATEX_TAGS = [
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
  'msup', 'msub', 'msubsup', 'mfrac', 'mover', 'munder', 'munderover',
  'mtable', 'mtr', 'mtd', 'msqrt', 'mroot', 'mspace', 'mpadded', 'menclose',
  'mstyle', 'mglyph', 'mmultiscripts', 'mprescripts', 'none',
]
const KATEX_ATTRS = ['mathvariant', 'encoding', 'xmlns', 'display', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder', 'columnalign', 'columnlines', 'columnspacing', 'rowlines', 'rowspacing', 'frame', 'framespacing', 'rowalign', 'columnwidth', 'width', 'height', 'depth', 'voffset', 'linethickness', 'scriptlevel', 'minsize', 'maxsize', 'movablelimits', 'notation', 'aria-hidden']

const props = withDefaults(defineProps<{
  prompt: string
  sections?: unknown
  showProvenance?: boolean
  emptyMessage?: string
  showTokenEstimate?: boolean
  title?: string
  collapsible?: boolean
  embedded?: boolean
  raw?: boolean
  searchable?: boolean
}>(), {
  emptyMessage: '',
  showTokenEstimate: false,
  showProvenance: true,
  title: '',
  collapsible: false,
})

const collapsed = defineModel<boolean>('collapsed', { default: false })

const { copied, busy: copyBusy, error: copyError, copy } = useTextCopy(() => props.prompt)

function preprocessCustomXml(text: string, fragments: string[]): string {
  text = text.replace(
    /<available_skills>\s*([\s\S]*?)\s*<\/available_skills>/g,
    (_match, inner: string) => {
      const skills = [...inner.matchAll(/<skill\s+name="([^"]*)">([\s\S]*?)<\/skill>/g)]
      const categories = [...inner.matchAll(/<category\s+name="([^"]*)"\s+count="([^"]*)"\s+skills="([^"]*)">([\s\S]*?)<\/category>/g)]
      if (skills.length === 0 && categories.length === 0) return ''
      const lines: string[] = []
      if (skills.length > 0) {
        lines.push(...skills.map(([, name, desc]) => `- **${name}** — ${desc.trim()}`))
      }
      if (categories.length > 0) {
        for (const [, catName, count, skillNames, desc] of categories) {
          lines.push(`- **${catName}** (${count}) — ${desc.trim()}`)
          // Only this generated wrapper is HTML; category content stays literal.
          const idx = fragments.push(`<sub>${escapeHtml(skillNames)}</sub>`) - 1
          lines.push(`  \uE000FRAGMENT${idx}\uE001`)
        }
      }
      return '### Available Skills\n\n' + lines.join('\n')
    },
  )
  text = text.replace(
    /<available_agent_types>\s*([\s\S]*?)\s*<\/available_agent_types>/g,
    (_match, inner: string) => {
      const items = [...inner.matchAll(/<agent_type\s+name="([^"]*)">([\s\S]*?)<\/agent_type>/g)]
      if (items.length === 0) return ''
      const lines = items.map(([, name, desc]) => `- **${name}** — ${desc.trim()}`)
      return '### Available Agent Types\n\n' + lines.join('\n')
    },
  )
  return text
}

function renderMarkdown(text: string): string {
  if (!text) return ''
  const fragments: string[] = []
  const src = preprocessCustomXml(text, fragments)
  let html = marked.render(src)
  html = html.replace(/\uE000FRAGMENT(\d+)\uE001/g, (_, i) => fragments[parseInt(i)])

  return mobileResources.html(DOMPurify.sanitize(html, {
    ADD_TAGS: KATEX_TAGS,
    ADD_ATTR: KATEX_ATTRS,
  }))
}

const validatedSections = computed(() => promptSections(props.prompt, props.sections))
const sectionHtml = computed(() => validatedSections.value.map(section => ({
  heading: section.name, body: renderMarkdown(section.content),
})))
const rendered = computed(() => renderMarkdown(props.prompt))
const query = ref('')
const activeHit = ref(0)
const searchRoot = ref<HTMLElement>()
const directions = [
  { step: -1, label: () => t('Previous match'), icon: 'i-lucide-chevron-up' },
  { step: 1, label: () => t('Next match'), icon: 'i-lucide-chevron-down' },
]
const search = computed(() => {
  const term = props.searchable ? query.value.trim() : ''
  const index = contextPreviewHighlighter(term)
  const sections = !props.raw ? sectionHtml.value.map(section => ({
    heading: index.plain(section.heading), body: index.highlight(section.body),
  })) : []
  const raw = props.raw ? index.plain(props.prompt) : []
  const body = props.raw || sections.length ? '' : index.highlight(rendered.value)
  return { sections, body, raw, count: index.count }
})

let activeMarks: HTMLElement[] = []
function revealHit() {
  for (const mark of activeMarks) mark.classList.remove('context-hit-active')
  const root = searchRoot.value
  activeMarks = root && search.value.count
    ? [...root.querySelectorAll<HTMLElement>(`[data-context-hit="${activeHit.value}"]`)] : []
  for (const mark of activeMarks) mark.classList.add('context-hit-active')
  const first = activeMarks[0]
  if (!first || !root) return
  for (let parent = first.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent instanceof HTMLDetailsElement && !parent.open && !parent.firstElementChild?.contains(first)) parent.open = true
  }
  first.scrollIntoView({ block: 'nearest', inline: 'nearest' })
}
watch(search, () => { activeHit.value = 0; revealHit() }, { flush: 'post' })
function moveHit(step: number) {
  const count = search.value.count
  if (!count) return
  activeHit.value = (activeHit.value + step + count) % count
  revealHit()
}
function searchKeydown(event: KeyboardEvent) {
  if (event.isComposing) return
  if (event.key === 'Enter') {
    event.preventDefault()
    moveHit(event.shiftKey ? -1 : 1)
  } else if (event.key === 'Escape' && query.value) {
    event.preventDefault()
    event.stopPropagation()
    query.value = ''
  }
}

</script>

<style scoped>
.prompt-sections { display: grid; gap: 16px; }
.prompt-section { padding: 20px; background: var(--c-bg-soft); border: 1px solid var(--c-border-soft); overflow-wrap: anywhere; min-width: 0; }
.prompt-section:nth-child(even) { background: var(--c-bg-muted); }
.prompt-section-heading { font-size: 12px; font-weight: 600; color: var(--c-text-secondary); }
.prompt-section-heading + .system-prompt-content { margin-top: 16px; }
summary.prompt-section-heading { cursor: pointer; }
.context-search { position: sticky; top: var(--definition-tabs-height, 0px); z-index: 1; display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 0; margin-bottom: 8px; background: var(--c-bg-card); border-bottom: 1px solid var(--c-border); }
.context-search-input { display: flex; align-items: center; gap: 8px; flex: 1 1 10rem; min-width: 0; max-width: 19rem; border: 1px solid var(--c-control-border); border-radius: var(--radius-control); padding: 0 8px; background: var(--c-bg-input); color: var(--c-text-secondary); }
.context-search-input:focus-within { outline: 2px solid var(--c-primary); outline-offset: 1px; }
.context-search-input input { min-width: 0; width: 100%; min-height: 32px; border: 0; outline: 0; background: transparent; color: var(--c-text); font-size: 13px; }
.context-search-input input::placeholder { color: var(--c-text-muted); }
.context-search-status { font-size: 12px; color: var(--c-text-secondary); font-variant-numeric: tabular-nums; }
.context-search-actions { display: flex; gap: 4px; }
.context-search-actions button { min-width: 32px; min-height: 32px; }
@container agent-browser (max-width: 700px) {
  .context-search-input input, .context-search-actions button { min-height: 44px; }
  .context-search-input input { font-size: 16px; }
  .context-search-actions button { min-width: 44px; }
}
:deep(mark[data-context-hit]) { background: var(--c-warn-bg); color: var(--c-text); scroll-margin-block-start: calc(var(--definition-tabs-height, 0px) + 100px); }
:deep(mark.context-hit-active) { background: var(--c-selection-bg); color: var(--c-text); outline: 1px solid var(--c-primary); }
.prompt-provenance-note { color: var(--c-text-secondary); font-size: 12px; margin-bottom: 16px; }
.card-collapsed {
  flex: 0 0 auto !important;
}

.card-header-toggle {
  cursor: pointer;
  user-select: none;
}

.card-header-toggle:hover {
  background: var(--c-bg-soft);
}

.card-chevron {
  font-size: 0.6rem;
  color: var(--c-text-muted);
  line-height: 1;
}

.copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  padding: 0.2rem 0.55rem;
  border: 1px solid var(--c-border);
  border-radius: var(--radius-pill);
  background: var(--c-bg-soft);
  color: var(--c-text-muted);
  font-size: 0.6rem;
  font-weight: 500;
  letter-spacing: 0.02em;
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.copy-btn:hover {
  color: var(--c-text);
  border-color: var(--c-border-hover);
  background: var(--c-bg-muted);
  transform: translateY(-1px) scale(1.04);
  box-shadow: 0 3px 10px var(--c-shadow-soft);
}

.copy-btn:active {
  transform: translateY(0) scale(0.97);
  box-shadow: none;
  transition-duration: 0.08s;
}

.copy-btn.copied {
  border-color: var(--c-success);
  color: var(--c-success);
  background: var(--c-success-bg);
}

.system-prompt-content {
  font-size: 0.8rem;
  line-height: 1.6;
  color: var(--c-text);
}

.system-prompt-content :deep(h1) { font-size: 1.1rem; margin-top: 1rem; }
.system-prompt-content :deep(h2) { font-size: 0.95rem; margin-top: 0.75rem; }
.system-prompt-content :deep(h3) { font-size: 0.85rem; margin-top: 0.5rem; }

.system-prompt-content :deep(pre) {
  background: var(--c-bg-muted);
  border-radius: var(--radius-control);
  padding: 0.5rem;
  overflow-x: auto;
  font-size: 0.75rem;
  line-height: 1.5;
  margin: 0.5rem 0;
  color: var(--c-text);
}

.system-prompt-content :deep(code) {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.8em;
  color: var(--c-text);
}

.system-prompt-content :deep(hr) {
  border: none;
  border-top: 1px solid var(--c-border);
  margin: 0.75rem 0;
}

.system-prompt-content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 0.5rem 0;
}
.system-prompt-content :deep(th),
.system-prompt-content :deep(td) {
  border: 1px solid var(--c-border);
  padding: 0.3rem 0.5rem;
  text-align: left;
  font-size: 0.75rem;
}
.system-prompt-content :deep(th) {
  background: var(--c-bg-soft);
  font-weight: 600;
}
.copy-error { margin: 8px 16px; color: var(--c-error); font-size: 12px; }
.system-prompt-raw { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font: 12px/1.7 'IBM Plex Mono', ui-monospace, monospace; color: var(--c-text-body); }
.prompt-embedded .system-prompt-content { max-width: 72ch; font-size: 14px; line-height: 1.7; color: var(--c-text-body); }
.prompt-embedded .system-prompt-content :deep(h1) { font-size: 20px; line-height: 1.4; margin: 0 0 20px; }
.prompt-embedded .system-prompt-content :deep(h2) { font-size: 16px; line-height: 1.5; margin: 24px 0 12px; }
.prompt-embedded .system-prompt-content :deep(h3) { font-size: 14px; line-height: 1.5; margin: 20px 0 8px; }
.prompt-embedded .system-prompt-content :deep(pre) { max-width: 100%; white-space: pre-wrap; overflow-wrap: anywhere; }
.prompt-embedded .system-prompt-content :deep(table) { display: block; max-width: 100%; overflow-x: auto; }
.prompt-embedded .prompt-empty { justify-content: flex-start; min-height: 44px; padding: 0; color: var(--c-text-secondary); font-size: 13px; }
</style>
