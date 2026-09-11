<template>
  <div class="rounded-md border border-default bg-surface flex flex-col min-w-0 min-h-0 flex-shrink-0 overflow-hidden" :style="!collapsed && maxHeight ? `max-height: ${maxHeight}` : ''">
    <div
      class="px-4 py-3 border-b border-default flex-shrink-0 flex items-center justify-between"
      :class="{ 'card-header-toggle': collapsible }"
      @click="collapsible && (collapsed = !collapsed)"
    >
      <div class="text-xs text-ink/50 font-600 uppercase tracking-widest flex items-center gap-2">
        <span v-if="collapsible" class="card-chevron" v-html="collapsed ? '&#9654;' : '&#9660;'" />
        Tools ({{ tools.length }})
      </div>
      <button
        v-if="tools.length"
        class="copy-btn"
        :class="{ copied }"
        @click.stop="copy"
      >
        <span class="w-3 h-3" :class="copied ? 'i-lucide-check' : 'i-lucide-copy'" aria-hidden="true" />
        {{ copied ? 'Copied!' : 'Copy JSON' }}
      </button>
    </div>
    <template v-if="!collapsible || !collapsed">
      <div v-if="!tools.length" class="flex-1 flex items-center justify-center text-ink/40 text-sm px-4 py-3">
        {{ emptyMessage || 'No tools available.' }}
      </div>
      <div v-else class="flex-1 overflow-y-auto px-4 py-3 min-h-0">
        <div class="tools-list">
          <div v-for="t in tools" :key="t.name" class="tool-def" @click="toggle(t.name)">
            <div class="tool-def-header">
              <span class="tool-def-name">{{ t.name }}</span>
              <span class="tool-def-toggle">{{ expanded.has(t.name) ? '&#9660;' : '&#9654;' }}</span>
            </div>
            <span v-if="!expanded.has(t.name)" class="tool-def-desc">{{ t.description }}</span>
            <template v-if="expanded.has(t.name)">
              <p class="tool-def-desc-full">{{ t.description }}</p>
              <div v-if="t.parameters?.properties" class="tool-def-params">
                <div v-for="(prop, key) in t.parameters.properties" :key="key" class="tool-def-param">
                  <span class="tool-def-param-name">{{ key }}<span v-if="t.parameters.required?.includes(String(key))" class="tool-def-required">*</span></span>
                  <span v-if="prop.type" class="tool-def-param-type">{{ prop.type }}</span>
                  <span v-if="prop.description" class="tool-def-param-desc">{{ prop.description }}</span>
                </div>
              </div>
            </template>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive } from 'vue'

export interface ToolDef {
  name: string
  description: string
  parameters?: {
    properties?: Record<string, { type?: string; description?: string }>
    required?: string[]
  }
}

const props = withDefaults(defineProps<{
  tools: ToolDef[]
  emptyMessage?: string
  maxHeight?: string
  collapsible?: boolean
}>(), {
  emptyMessage: 'No tools available.',
  maxHeight: '',
  collapsible: false,
})

const collapsed = defineModel<boolean>('collapsed', { default: false })

const copied = ref(false)
const expanded = reactive(new Set<string>())

function toggle(name: string) {
  if (expanded.has(name)) expanded.delete(name)
  else expanded.add(name)
}

function copy() {
  if (!props.tools.length) return
  navigator.clipboard.writeText(JSON.stringify(props.tools, null, 2))
  copied.value = true
  setTimeout(() => { copied.value = false }, 2000)
}
</script>

<style scoped>
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

.tools-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.tool-def {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  padding: 0.4rem 0.5rem;
  border-radius: var(--radius-control);
  background: var(--c-bg-soft);
  cursor: pointer;
  user-select: none;
  transition: background 0.1s ease, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.tool-def:hover {
  background: var(--c-bg-muted);
  transform: translateX(2px);
}

.tool-def-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.tool-def-name {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.7rem;
  font-weight: 600;
  color: var(--c-text-secondary);
}

.tool-def-toggle {
  font-size: 0.5rem;
  color: var(--c-text-muted);
  flex-shrink: 0;
}

.tool-def-desc {
  font-size: 0.65rem;
  color: var(--c-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.tool-def-desc-full {
  font-size: 0.65rem;
  color: var(--c-text-body);
  margin: 0.15rem 0 0.3rem;
  line-height: 1.4;
}

.tool-def-params {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.1rem;
  padding-top: 0.3rem;
  border-top: 1px solid var(--c-border);
}

.tool-def-param {
  display: flex;
  flex-direction: column;
  gap: 0.05rem;
  padding-left: 0.4rem;
  border-left: 2px solid var(--c-border-soft);
}

.tool-def-param-name {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.65rem;
  font-weight: 600;
  color: var(--c-text-secondary);
}

.tool-def-required {
  color: var(--c-error);
  margin-left: 1px;
}

.tool-def-param-type {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.6rem;
  color: var(--c-text-muted);
}

.tool-def-param-desc {
  font-size: 0.6rem;
  color: var(--c-text-body);
  line-height: 1.35;
}
</style>
