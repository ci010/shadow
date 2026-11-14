<template>
  <section class="explorer-root" :class="{ expanded }" :data-root-id="rootId">
    <HoverInfo :text="hint || label" v-slot="{ triggerProps }">
    <button v-bind="triggerProps" class="root-toggle" :aria-expanded="expanded" :aria-controls="treeId" @click="expanded = !expanded"><span :class="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" /><span :class="folder ? 'i-lucide-folder' : 'i-lucide-messages-square'" class="root-kind" aria-hidden="true" /><span class="root-name">{{ label }}</span><span v-if="source" class="root-source">{{ source }}</span></button>
    </HoverInfo>
    <div v-if="expanded" :id="treeId">
      <FileTree :api-base="apiBase" :session-id="sessionId" :folder-id="folder?.id" :session-workspace="!folder" :remote="folder?.kind === 'remote'" tree-only :active="active" :git-status="status" :git-loading="loading" :git-error="error" :git-offline="offline" @refresh-git="refresh" @open="emit('open', { ...$event, source: folder ? { folderId: folder.id, remote: folder.kind === 'remote' } : { sessionId, sessionWorkspace: true } })" />
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import HoverInfo from '../HoverInfo.vue'
import FileTree from './FileTree.vue'
import { useWorkdirGit } from '../../composables/useWorkdirGit.ts'
import type { FolderRecord } from '../../folders-client.ts'
import type { OpenFile } from '../../file-workbench.ts'
const props = defineProps<{ apiBase: string; sessionId: string; folder?: FolderRecord; label: string; hint?: string; source?: string; rootId: string; active: boolean; reveal?: boolean }>()
const emit = defineEmits<{ open: [file: OpenFile] }>()
const expanded = ref(false)
// Additive reveal: preserve other roots and allow manual collapse until the
// main selection changes or the explorer is opened again.
watch(() => props.reveal, reveal => { if (reveal) expanded.value = true }, { immediate: true })
const treeId = `project-tree-${useId()}`
const { status, loading, error, offline, refresh } = useWorkdirGit(() => ({ apiBase: props.apiBase, sessionId: props.sessionId, folderId: props.folder?.id, sessionWorkspace: !props.folder }), computed(() => props.active && expanded.value))
</script>
<style scoped>
/* Each resource owns its scrolling content; sibling headings never scroll away. */
.explorer-root { display: flex; flex-direction: column; flex: 0 0 auto; min-width: 0; min-height: 0; overflow: hidden; }
.explorer-root.expanded { flex: 1 1 0; }
.explorer-root > :deep(.hover-info-anchor) { flex-shrink: 0; }
.explorer-root > div { display: flex; flex: 1; min-width: 0; min-height: 0; overflow: hidden; }
.root-toggle { flex-shrink: 0; display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; border: 0; padding: 6px 8px; background: transparent; color: var(--c-text); font: inherit; font-size: 12px; text-align: left; }
.root-toggle:hover { background: var(--c-bg-muted); }
.root-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.root-toggle > span:first-child { width: 14px; height: 14px; flex-shrink: 0; }
.root-kind { flex: 0 0 14px; width: 14px; height: 14px; color: var(--c-text-muted); }
.root-name { min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; flex: 1; }
.root-source { max-width: 76px; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; color: var(--c-text-muted); font-size: 11px; flex-shrink: 0; }
</style>
