<template>
  <Teleport v-if="header.visible.value && header.chrome?.headerTarget.value" :to="header.chrome.headerTarget.value">
    <button class="mobile-document-title" :aria-label="t('Switch view')" aria-haspopup="dialog" :aria-expanded="viewsOpen" @click="viewsOpen = true"><span class="mobile-document-label">{{ current?.label }}</span><span class="i-lucide-chevron-down" aria-hidden="true" /></button>
    <HoverInfo :text="t('Conversation and document actions')" v-slot="{ triggerProps }"><button v-bind="triggerProps" class="mobile-document-more" :aria-label="t('Conversation and document actions')" aria-haspopup="dialog" :aria-expanded="actionsOpen" @click="actionsOpen = true"><span class="i-lucide-ellipsis" aria-hidden="true" /></button></HoverInfo>
  </Teleport>
  <MobileSheet :open="viewsOpen" :label="t('Open views')" @update:open="viewsOpen = $event">
    <div v-for="entry in entries" :key="entry.id" class="mobile-view-row"><button :aria-current="entry.id === current?.id ? 'page' : undefined" @click="groups.activate(entry.id); viewsOpen = false">{{ entry.label }}</button><HoverInfo v-if="entry.closable" :text="t('Close {value1}', { value1: entry.label })" v-slot="{ triggerProps }"><button class="mobile-view-close" v-bind="triggerProps" :aria-label="t('Close {value1}', { value1: entry.label })" @click="groups.close(entry.id)"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo></div>
    <template v-for="group in otherProjectTabs" :key="group.id">
      <div v-for="entry in group.tabs" :key="entry.id" class="mobile-view-row">
        <button @click="emit('activateProjectTab', entry.id); viewsOpen = false">{{ group.name }} · {{ entry.label }}</button>
        <HoverInfo v-if="entry.closable" :text="t('Close {value1}', { value1: entry.label })" v-slot="{ triggerProps }"><button class="mobile-view-close" v-bind="triggerProps" :aria-label="t('Close {value1}', { value1: entry.label })" @click="groups.close(entry.id)"><span class="i-lucide-x" aria-hidden="true" /></button></HoverInfo>
      </div>
    </template>
  </MobileSheet>
  <MobileSheet :open="actionsOpen" :label="t('Conversation and document actions')" @update:open="actionsOpen = $event">
    <div class="mobile-workbench-actions"><button v-if="hasExplorer" @click="groups.setExplorerOpen(projectId, true); actionsOpen = false">{{ t('Browse files') }}</button><button v-if="current?.closable" @click="groups.close(current.id); actionsOpen = false">{{ t('Close current document') }}</button></div>
  </MobileSheet>
</template>
<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import type { ProjectTopTabGroup } from '../project-top-tabs.ts'
import { EditorGroupsKey } from '../editor-groups.ts'
import { useMobileHeader } from '../composables/useMobileChrome.ts'
import { t } from '../i18n.ts'
import MobileSheet from './MobileSheet.vue'
import HoverInfo from './HoverInfo.vue'
const props = defineProps<{ projectId: string; active: boolean; hasExplorer?: boolean; otherProjectTabs?: ProjectTopTabGroup[] }>()
const emit = defineEmits<{ activateProjectTab: [id: string] }>()
const groups = inject(EditorGroupsKey)!
const current = computed(() => groups.active(props.projectId))
// FileWorkbench owns conversation/file actions. Project documents and explorer
// files have no FileWorkbench owner, so the shared host supplies their chrome.
const header = useMobileHeader(() => props.active && (current.value?.owner === props.projectId || current.value?.owner === `${props.projectId}:explorer`))
const entries = computed(() => { const state = groups.state(props.projectId); return [...state.left, ...state.right].flatMap(id => { const entry = groups.descriptors.get(id); return entry ? [entry] : [] }) })
const viewsOpen = ref(false), actionsOpen = ref(false)
watch(header.visible, visible => { if (!visible) { viewsOpen.value = false; actionsOpen.value = false } })
</script>
<style scoped>
.mobile-document-title { display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0; min-height: 44px; padding: 8px; border: 0; background: transparent; color: var(--c-text); font: inherit; text-align: left; }
.mobile-document-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mobile-document-more { display: grid; place-items: center; width: 44px; height: 44px; border: 0; background: transparent; color: var(--c-text); }
.mobile-workbench-actions button { min-height: 44px; padding: 12px; border: 0; background: transparent; color: var(--c-text); font: inherit; }
.mobile-workbench-actions { display: flex; flex-direction: column; }
button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: -2px; }
</style>
