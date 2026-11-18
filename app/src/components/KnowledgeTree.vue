<template>
  <ul class="knowledge-tree">
    <li v-for="node in nodes" :key="node.id">
      <HoverInfo v-if="node.entry" :text="node.entry.path" v-slot="{ triggerProps }">
        <button v-bind="triggerProps" :aria-current="selectedId === node.id ? 'page' : undefined" @click="$emit('select', node.id)"><span class="i-lucide-file-text" aria-hidden="true" /><span class="label">{{ node.label }}</span></button>
      </HoverInfo>
      <details v-else open>
        <summary><span class="i-lucide-folder" aria-hidden="true" />{{ folderLabel(node) }}</summary>
        <p v-if="node.id === 'memory'" class="memory-note">{{ t('Session history, semantic logs and conventions; not file-edit history or curated Wiki pages.') }}</p>
        <KnowledgeTree :nodes="node.children" :depth="depth + 1" :selected-id="selectedId" @select="$emit('select', $event)" />
      </details>
    </li>
  </ul>
</template>
<script setup lang="ts">
import type { KnowledgeTreeNode } from '../knowledge-tree.ts'
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
const props = withDefaults(defineProps<{ nodes: KnowledgeTreeNode[]; selectedId?: string; depth?: number }>(), { depth: 0 })
function folderLabel(node: KnowledgeTreeNode) {
  if (props.depth === 0) {
    if (node.id === 'wiki') return t('Wiki')
    if (node.id === 'memory') return t('Memory')
    if (node.id === 'skill') return t('Skills')
    if (node.id === 'agents') return t('Agents')
    if (node.id === 'bots') return t('Bots')
  }
  if (props.depth === 1 && /^(skill|agents)\//.test(node.id)) {
    if (node.label === 'Project') return t('Project')
    if (node.label === 'Workspace') return t('Workspace')
    if (node.label === 'Built-in') return t('Built-in')
  }
  return node.label
}
defineEmits<{ select: [id: string] }>()
</script>
<style scoped>
.knowledge-tree { list-style: none; margin: 0; padding: 0; }
.knowledge-tree .knowledge-tree { padding-left: 16px; }
button, summary { min-height: 32px; box-sizing: border-box; padding: 6px 4px; color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
button { display: flex; align-items: center; gap: 8px; width: 100%; text-align: left; border: 0; background: transparent; }
summary > span { display: inline-block; width: 16px; height: 16px; margin-right: 8px; vertical-align: middle; }
button > span:first-child { width: 16px; height: 16px; flex-shrink: 0; }
.memory-note { margin: 0 4px 8px; font-size: 12px; color: var(--c-text-secondary); }
.label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
button:hover, summary:hover { background: var(--c-bg-muted); }
button[aria-current] { background: var(--c-selection-bg); color: var(--c-primary); }
button:focus-visible, summary:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
@media (max-width: 700px), (pointer: coarse) { button, summary { min-height: 44px; } }
</style>
