<template>
  <div class="project-conversation">
    <div v-if="error" class="project-model-error" role="alert">
      {{ error }}
      <button class="btn btn-sm" :disabled="loading" @click="load">{{ t('Retry models') }}</button>
      <RouterLink :to="{ name: 'project-settings', params: { projectId, section: 'models' } }">{{ t('Project models') }}</RouterLink>
      <RouterLink :to="{ name: 'settings', params: { section: 'providers' } }">{{ t('App providers') }}</RouterLink>
    </div>
    <ChatWorkspace ref="workspace" :api-base="apiBase" managed :project-id="projectId" :project-name="projectName"
      :knowledge-request="knowledgeRequest" @knowledge-navigation="(active, entryId) => $emit('knowledge-navigation', active, entryId)"
      @project-navigation="$emit('project-navigation', $event)"
      :session-id="sessionId" :initial-folder="initialFolder" :open-remote="openRemote" :visible="visible" :child-session-id="childSessionId" :automation-run="automationRun"
      @navigate="(id, child) => $emit('navigate', id, child)" @prepared="$emit('prepared', $event)" @deleted="$emit('deleted', $event)" />
  </div>
</template>

<script setup lang="ts">
import { t } from '../i18n.ts'
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ChatWorkspace from './ChatWorkspace.vue'
import { createProjectSettingsClient, configReasoning } from '../project-settings.ts'
import type { ReasoningSettings } from '../session-settings.ts'
import { provideModelSelection, type ProviderInstanceLabel } from '../model-selection.ts'
import type { FolderRecord } from '../folders-client.ts'
import type { KnowledgeTabRequest, ProjectTab } from '../file-workbench.ts'

const props = defineProps<{
  apiBase: string; projectId: string; projectName: string; sessionId: string
  initialFolder?: FolderRecord; openRemote?: boolean; visible: boolean; childSessionId?: string
  knowledgeRequest?: KnowledgeTabRequest
  automationRun?: boolean
}>()
const emit = defineEmits<{ navigate: [id: string, child?: string]; prepared: [id: string]; deleted: [id: string]; 'knowledge-navigation': [active: boolean, entryId?: string]; 'project-navigation': [tab?: ProjectTab]; 'dashboard-visible': [visible: boolean] }>()
const workspace = ref<InstanceType<typeof ChatWorkspace>>()
const current = ref('')
const defaultReasoning = ref<ReasoningSettings>({})
const options = ref<string[]>([])
const providers = ref<ProviderInstanceLabel[]>([])
const error = ref('')
const loading = ref(false)
let request: AbortController | undefined
let previousDefault: string | undefined
provideModelSelection({
  current, defaultReasoning, options, providers, error, loading, disabled: computed(() => loading.value),
  async select(model) {
    if (!model.trim()) { error.value = t('Choose a model for this conversation.'); return }
    current.value = model
    error.value = ''
  },
})
async function load() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const client = createProjectSettingsClient(props.apiBase)
  try {
    const [config, models] = await Promise.all([client.load(controller.signal), client.catalog(controller.signal)])
    if (controller.signal.aborted) return
    if (!current.value || current.value === previousDefault) current.value = config.agent.model
    previousDefault = config.agent.model
    defaultReasoning.value = configReasoning(config)
    options.value = models.models
    providers.value = models.providers
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load project models. Retry.')
  } finally { if (request === controller) loading.value = false }
}
onMounted(load)
function defaultsChanged(event: Event) {
  const id = (event as CustomEvent<{ projectId?: string }>).detail?.projectId
  if (!id || id === props.projectId) void load()
}
onMounted(() => window.addEventListener('shadow:config-changed', defaultsChanged))
onUnmounted(() => {
  request?.abort()
  window.removeEventListener('shadow:config-changed', defaultsChanged)
})
defineExpose({ appendDraft: (text: string) => workspace.value?.appendDraft(text), requestSession: (id: string) => workspace.value?.requestSession(id) })
</script>

<style scoped>
.project-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.project-model-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; color: var(--c-error); font-size: 12px; }
.project-model-error a { color: var(--c-text); }
</style>
