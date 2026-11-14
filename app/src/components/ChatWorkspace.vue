<template>
  <div class="conversation-workspace">
    <div class="primary-conversation">
      <FileWorkbench v-if="discordChannelKey(sessionId || '')" :api-base="apiBase" session-id="" :project-id="projectId" :context-key="sessionId || ''" :active="visible" :explorer-enabled="false" :project-navigation-enabled="!embedded" :knowledge-enabled="!embedded" :knowledge-request="knowledgeRequest"
        @knowledge-navigation="(active, entryId) => emit('knowledge-navigation', active, entryId)" @project-navigation="(tab, documentKey) => emit('project-navigation', tab, documentKey)" :conversation-title="t('Channel content')">
        <DiscordChannelIndex :api-base="apiBase" :project-id="projectId || ''" :channel-key="discordChannelKey(sessionId || '')!" :active="visible" @open="emit('navigate', $event)" />
      </FileWorkbench>
      <FileWorkbench v-else-if="observedGroupKey(sessionId || '')" :api-base="apiBase" session-id="" :project-id="projectId" :context-key="sessionId || ''" :active="visible" :explorer-enabled="false" :project-navigation-enabled="!embedded" :knowledge-enabled="!embedded" :knowledge-request="knowledgeRequest"
        @knowledge-navigation="(active, entryId) => emit('knowledge-navigation', active, entryId)"
        @project-navigation="(tab, documentKey) => emit('project-navigation', tab, documentKey)" :conversation-title="t('Received messages')">
        <div class="observed-chat"><ChannelGroupContext :api-base="apiBase" :project-id="projectId || ''" :group-key="observedGroupKey(sessionId || '')!" :active="visible" discovery-only /></div>
      </FileWorkbench>
      <ChatTab v-else ref="primary" :api-base="apiBase" :embedded="embedded || inspection" :enable-child-pane="true"
        :knowledge-request="knowledgeRequest" @knowledge-navigation="(active, entryId) => emit('knowledge-navigation', active, entryId)"
        @project-navigation="(tab, documentKey) => emit('project-navigation', tab, documentKey)"
        :inspection="inspection" :project-id="projectId" :project-name="projectName" :managed="managed" :session-id="sessionId" :initial-folder="initialFolder" :open-remote="openRemote" :automation-run="automationRun"
        :visible="visible" :keyboard-active="keyboardActive"
        @open-child="target => emit('navigate', target.primaryId, target.childId)" @close-child="emit('navigate', sessionId || '')" @deleted="emit('deleted', $event)" @navigate="emit('navigate', $event)" @child-navigation="emit('navigate', sessionId || '', $event)" @prepared="emit('prepared', $event)">
        <template #notice><slot name="notice" /></template>
      </ChatTab>
    </div>
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import type { LabeledInputReference, AttachReferenceResult } from '../workflow-input-references.ts'
import { ref } from 'vue'
import DiscordChannelIndex from './DiscordChannelIndex.vue'
import { discordChannelKey } from '../discord-navigation.ts'
import ChatTab from './ChatTab.vue'
import FileWorkbench from './files/FileWorkbench.vue'
import ChannelGroupContext from './ChannelGroupContext.vue'
import { observedGroupKey } from '../service-groups.ts'
import type { FolderRecord } from '../folders-client.ts'
import type { KnowledgeTabRequest, ProjectTab } from '../file-workbench.ts'

const props = withDefaults(defineProps<{ apiBase: string; projectId?: string; projectName?: string; managed?: boolean; embedded?: boolean; keyboardActive?: boolean; sessionId?: string; initialFolder?: FolderRecord; openRemote?: boolean; visible?: boolean; childSessionId?: string; knowledgeRequest?: KnowledgeTabRequest; automationRun?: boolean; inspection?: boolean }>(), { visible: true, embedded: false, keyboardActive: true })
const emit = defineEmits<{ navigate: [id: string, childId?: string]; prepared: [id: string]; deleted: [id: string]; 'knowledge-navigation': [active: boolean, entryId?: string]; 'project-navigation': [tab?: ProjectTab, documentKey?: string] }>()
const primary = ref<InstanceType<typeof ChatTab>>()
defineExpose({ canReplaceSidebarTab: () => primary.value?.canReplaceSidebarTab() ?? false, appendInputReference: (item: LabeledInputReference): AttachReferenceResult => primary.value?.appendInputReference(item) ?? 'unavailable',
  requestSession: (id: string) => primary.value?.requestSession(id),
  appendDraft: (text: string) => {
    primary.value?.appendDraft(text)
  },
  focusConversation: () => primary.value?.focusConversation(),
  quoteSelection: (text: string) => primary.value?.quoteSelection(text),
  handleImageContext: (update: Parameters<InstanceType<typeof ChatTab>['handleImageContext']>[0]) => primary.value?.handleImageContext(update),
  handleImageBusy: (update: Parameters<InstanceType<typeof ChatTab>['handleImageBusy']>[0]) => primary.value?.handleImageBusy(update),
})
</script>

<style scoped>
.observed-chat { flex: 1; overflow-y: auto; padding: 12px 24px; min-height: 0; min-width: 0; }
.conversation-workspace, .primary-conversation { display: flex; flex: 1; min-width: 0; min-height: 0; }
</style>
