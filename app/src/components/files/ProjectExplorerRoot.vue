<template>
  <section class="explorer-root" :data-root-id="rootId">
    <button class="root-toggle" :aria-expanded="expanded" :aria-controls="treeId" @click="expanded = !expanded"><span :class="expanded ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'" aria-hidden="true" /><span>{{ label }}</span></button>
    <div v-if="expanded" :id="treeId">
      <FileTree :api-base="apiBase" :session-id="sessionId" :folder-id="folder?.id" :session-workspace="!folder" :remote="folder?.kind === 'remote'" tree-only :active="active" :git-status="status" :git-loading="loading" :git-error="error" :git-offline="offline" @refresh-git="refresh" @open="emit('open', { ...$event, source: folder ? { folderId: folder.id, remote: folder.kind === 'remote' } : { sessionId, sessionWorkspace: true } })" />
    </div>
  </section>
</template>
<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import FileTree from './FileTree.vue'
import { useWorkdirGit } from '../../composables/useWorkdirGit.ts'
import type { FolderRecord } from '../../folders-client.ts'
import type { OpenFile } from '../../file-workbench.ts'
const props = defineProps<{ apiBase: string; sessionId: string; folder?: FolderRecord; label: string; rootId: string; active: boolean }>()
const emit = defineEmits<{ open: [file: OpenFile] }>()
const expanded = ref(false)
const treeId = `project-tree-${useId()}`
const { status, loading, error, offline, refresh } = useWorkdirGit(() => ({ apiBase: props.apiBase, sessionId: props.sessionId, folderId: props.folder?.id, sessionWorkspace: !props.folder }), computed(() => props.active && expanded.value))
</script>
<style scoped>
.root-toggle { display: flex; align-items: center; gap: 6px; width: 100%; min-height: 32px; border: 0; padding: 6px 8px; background: transparent; color: var(--c-text); font: inherit; font-size: 12px; text-align: left; }
.root-toggle:hover { background: var(--c-bg-muted); }
.root-toggle:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
.root-toggle > span:first-child { width: 14px; height: 14px; flex-shrink: 0; }
.root-toggle > span:last-child { overflow-wrap: anywhere; }
</style>
