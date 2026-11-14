<template>
  <FileDiffPreview v-if="file.view === 'diff'" :api-base="apiBase" :session-id="source.sessionId ?? ''" :folder-id="source.folderId" :session-workspace="source.sessionWorkspace" :path="file.path" :active="active" :selection-active="active" :can-quote="canQuote" @quote="emit('quote', $event)" :revision="revision" @open-source="emit('open', { ...file, view: undefined })" />
  <FilePreviewModal v-else inline :remote="source.remote" :api-base="apiBase" :session-id="source.sessionId ?? ''" :folder-id="source.folderId" :session-workspace="source.sessionWorkspace" :context-key="fileTabKey(file)" :active="active" :selection-active="active" :can-quote="canQuote" @quote="emit('quote', $event)" :entry="file.entry" :dir="file.path.includes('/') ? file.path.slice(0, file.path.lastIndexOf('/')) : ''" @close="emit('close')" />
</template>
<script setup lang="ts">
import { computed } from 'vue'
import { fileTabKey, type OpenFile } from '../../file-workbench.ts'
import { useWorkdirGit } from '../../composables/useWorkdirGit.ts'
import FileDiffPreview from './FileDiffPreview.vue'
import FilePreviewModal from './FilePreviewModal.vue'
const props = defineProps<{ apiBase: string; file: OpenFile; active: boolean; canQuote: boolean }>()
const emit = defineEmits<{ open: [file: OpenFile]; close: []; quote: [text: string] }>()
// Central explorer always supplies a concrete source; never infer another conversation.
const source = computed(() => props.file.source!)
const { revision } = useWorkdirGit(() => ({ apiBase: props.apiBase, sessionId: source.value.sessionId ?? '', folderId: source.value.folderId, sessionWorkspace: source.value.sessionWorkspace }), computed(() => props.active && props.file.view === 'diff'))
</script>
