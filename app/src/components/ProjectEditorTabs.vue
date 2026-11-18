<template>
  <nav class="project-editor-tabs" :aria-label="t('Open documents')" @wheel="scrollEditorTabs($event, $event.currentTarget as HTMLElement)">
    <div v-for="group in groups" :key="group.id" class="project-editor-tab-group" role="group" :aria-label="group.name" :data-project-id="group.id">
      <span class="editor-project-marker" aria-hidden="true">{{ group.name }}</span>
      <div v-for="editor in group.tabs" :key="editor.id" class="project-editor-tab" @mousedown="$event.button === 1 && $event.preventDefault()" @auxclick="middleClose($event, editor.id, editor.closable)">
        <HoverInfo :text="editor.label" v-slot="{ triggerProps }"><button v-bind="triggerProps" type="button" class="project-editor-label" @click="emit('activate', editor.id)"><SessionActivity v-if="editor.activity" v-bind="editor.activity" compact icon-only status-icons /><span v-else :class="editor.icon" aria-hidden="true" /><span>{{ editor.label }}</span></button></HoverInfo>
        <HoverInfo v-if="editor.closable" :text="t('Close')" v-slot="{ triggerProps }"><button v-bind="triggerProps" type="button" :aria-label="t('Close {value1}', { value1: editor.label })" @click="emit('close', editor.id)"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo>
      </div>
    </div>
  </nav>
</template>

<script setup lang="ts">
import type { ProjectTopTabGroup } from '../project-top-tabs.ts'
import { scrollEditorTabs } from '../editor-tab-scroll.ts'
import { t } from '../i18n.ts'
import HoverInfo from './HoverInfo.vue'
import SessionActivity from './SessionActivity.vue'

defineProps<{ groups: ProjectTopTabGroup[] }>()
const emit = defineEmits<{ activate: [id: string]; close: [id: string] }>()
function middleClose(event: MouseEvent, id: string, closable: boolean) {
  if (event.button !== 1 || !closable) return
  event.preventDefault()
  emit('close', id)
}
</script>

<style scoped>
.project-editor-tabs { display: flex; min-width: 0; overflow-x: auto; overflow-y: hidden; scrollbar-width: thin; }
.project-editor-tab-group, .project-editor-tab { display: flex; flex: none; align-items: stretch; }
.project-editor-tab { height: 36px; box-sizing: border-box; border-top: 2px solid transparent; border-inline-end: 1px solid var(--c-border); }
.project-editor-tab button { display: flex; align-items: center; gap: 5px; padding: 0 6px; border: 0; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 12px; cursor: pointer; }
.project-editor-tab button:hover { background: var(--c-bg-muted); color: var(--c-text); }
.project-editor-tab button:focus-visible { outline: 2px solid var(--c-primary); outline-offset: -2px; }
.project-editor-label > span:last-child { max-width: 12rem; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>

<style>
.editor-project-marker { align-self: center; flex: none; max-width: 8rem; margin-inline: 5px; padding: 2px 6px; border-radius: 4px; background: var(--c-bg-muted); color: var(--c-text-secondary); font-size: 0.65rem; line-height: 1.2; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style>
