<template>
  <ul class="knowledge-tree">
    <li v-for="node in nodes" :key="node.id">
      <TreeRow :label="node.entry ? node.label : folderLabel(node)" :title="node.entry?.path"
        :depth="depth" :expanded="node.entry ? undefined : isExpanded(node)"
        :selected="!!node.entry && selectedId === node.id" :current="node.entry && selectedId === node.id ? 'page' : undefined"
        @select="activate(node)">
        <template #icon><span :class="nodeIcon(node)" /></template>
      </TreeRow>
      <div v-if="!node.entry" v-show="isExpanded(node)">
        <p v-if="node.id === 'memory'" class="memory-note">{{ t('Session history, semantic logs and conventions; not file-edit history or curated Wiki pages.') }}</p>
        <KnowledgeTree :nodes="node.children" :depth="depth + 1" :searching="searching" :selected-id="selectedId" @select="$emit('select', $event)" />
      </div>
    </li>
  </ul>
</template>
<script setup lang="ts">
import { reactive } from 'vue'
import { fileIcon, folderIcon } from '../file-icons.ts'
import type { KnowledgeTreeNode } from '../knowledge-tree.ts'
import { t } from '../i18n.ts'
import TreeRow from './TreeRow.vue'

const props = withDefaults(defineProps<{ nodes: KnowledgeTreeNode[]; selectedId?: string; depth?: number; searching?: boolean }>(), { depth: 0 })
const emit = defineEmits<{ select: [id: string] }>()
const expanded = reactive(new Map<string, boolean>())
const rootIcons: Readonly<Record<string, string>> = {
  wiki: 'i-lucide-library',
  memory: 'i-lucide-brain',
  skill: 'i-lucide-blocks',
  agents: 'i-lucide-cpu',
  bots: 'i-lucide-bot',
}
function isExpanded(node: KnowledgeTreeNode) {
  return expanded.get(node.id) ?? (!!props.searching && node.children.length > 0)
}
function activate(node: KnowledgeTreeNode) {
  if (node.entry) emit('select', node.id)
  else expanded.set(node.id, !isExpanded(node))
}
function nodeIcon(node: KnowledgeTreeNode) {
  if (node.entry) return fileIcon(node.entry.path.split('/').pop() ?? node.label)
  if (props.depth === 0 && rootIcons[node.id]) return rootIcons[node.id]
  return folderIcon(node.label, isExpanded(node))
}
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
</script>
<style scoped>
.knowledge-tree { list-style: none; margin: 0; padding: 0; }
.memory-note { margin: 0 6px 8px 32px; font-size: 12px; color: var(--c-text-secondary); }
@media (max-width: 700px), (pointer: coarse) { .knowledge-tree { --tree-row-height: 44px; } }
</style>
