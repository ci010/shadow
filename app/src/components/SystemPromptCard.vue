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
        {{ title }}
        <span v-if="prompt && showTokenEstimate" class="font-400 normal-case tracking-normal text-ink/35">
          (~{{ Math.round(prompt.length / 4) }} tokens)
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
        {{ copied ? 'Copied!' : 'Copy' }}
      </button>
    </div>
    <p v-if="copyError && !embedded" class="copy-error" role="alert">{{ copyError }}</p>
    <template v-if="!collapsible || !collapsed">
      <div v-if="!prompt && emptyMessage" class="prompt-empty flex-1 flex items-center justify-center text-ink/40 text-sm px-4">
        {{ emptyMessage }}
      </div>
      <div v-else-if="prompt" :class="embedded ? 'prompt-content' : 'flex-1 overflow-y-auto px-4 py-3 min-h-0'">
        <pre v-if="raw" class="system-prompt-raw">{{ prompt }}</pre>
        <div v-else class="prose max-w-none system-prompt-content" v-html="rendered" />
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import DOMPurify from 'dompurify'
import { useMobileResources } from '../mobile-resources.ts'
const mobileResources = useMobileResources()
import { marked } from 'marked'
import katex from 'katex'
import { useTextCopy } from '../composables/useTextCopy.ts'

marked.setOptions({ breaks: true })

const KATEX_TAGS = [
  'math', 'semantics', 'annotation', 'mrow', 'mi', 'mo', 'mn', 'ms', 'mtext',
  'msup', 'msub', 'msubsup', 'mfrac', 'mover', 'munder', 'munderover',
  'mtable', 'mtr', 'mtd', 'msqrt', 'mroot', 'mspace', 'mpadded', 'menclose',
  'mstyle', 'mglyph', 'mmultiscripts', 'mprescripts', 'none',
]
const KATEX_ATTRS = ['mathvariant', 'encoding', 'xmlns', 'display', 'stretchy', 'fence', 'separator', 'lspace', 'rspace', 'accent', 'accentunder', 'columnalign', 'columnlines', 'columnspacing', 'rowlines', 'rowspacing', 'frame', 'framespacing', 'rowalign', 'columnwidth', 'width', 'height', 'depth', 'voffset', 'linethickness', 'scriptlevel', 'minsize', 'maxsize', 'movablelimits', 'notation', 'aria-hidden']

const props = withDefaults(defineProps<{
  prompt: string
  emptyMessage?: string
  showTokenEstimate?: boolean
  title?: string
  collapsible?: boolean
  embedded?: boolean
  raw?: boolean
}>(), {
  emptyMessage: '',
  showTokenEstimate: false,
  title: 'System Prompt',
  collapsible: false,
})

const collapsed = defineModel<boolean>('collapsed', { default: false })

const { copied, busy: copyBusy, error: copyError, copy } = useTextCopy(() => props.prompt)

function preprocessCustomXml(text: string): string {
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
          lines.push(`  <sub>${skillNames}</sub>`)
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
  const mathBlocks: string[] = []
  let src = preprocessCustomXml(text)

  src = src.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const idx = mathBlocks.length
    try {
      mathBlocks.push(katex.renderToString(math.trim(), { displayMode: true, throwOnError: false }))
    } catch { mathBlocks.push(`$$${math}$$`) }
    return `\x00MATH${idx}\x00`
  })

  src = src.replace(/\$([^\$\n]+?)\$/g, (_, math) => {
    const idx = mathBlocks.length
    try {
      mathBlocks.push(katex.renderToString(math.trim(), { displayMode: false, throwOnError: false }))
    } catch { mathBlocks.push(`$${math}$`) }
    return `\x00MATH${idx}\x00`
  })

  let html = marked.parse(src, { async: false }) as string
  html = html.replace(/\x00MATH(\d+)\x00/g, (_, i) => mathBlocks[parseInt(i)])

  return mobileResources.html(DOMPurify.sanitize(html, {
    ADD_TAGS: KATEX_TAGS,
    ADD_ATTR: KATEX_ATTRS,
  }))
}

const rendered = computed(() => renderMarkdown(props.prompt))

</script>

<style scoped>
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
