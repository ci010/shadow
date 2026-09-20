<template>
  <div class="project-conversation">
    <div v-if="error" class="project-model-error" role="alert">
      {{ error }}
      <button class="btn btn-sm" :disabled="loading" @click="load">Retry models</button>
      <RouterLink :to="{ name: 'project-settings', params: { projectId, section: 'models' } }">Project models</RouterLink>
      <RouterLink :to="{ name: 'settings', params: { section: 'providers' } }">App providers</RouterLink>
    </div>
    <ChatWorkspace ref="workspace" :api-base="apiBase" managed :project-id="projectId" :project-name="projectName"
      :knowledge-request="knowledgeRequest" @knowledge-navigation="(active, entryId) => $emit('knowledge-navigation', active, entryId)"
      :session-id="sessionId" :initial-folder="initialFolder" :open-remote="openRemote" :visible="visible" :child-session-id="childSessionId"
      @navigate="(id, child) => $emit('navigate', id, child)" @prepared="$emit('prepared', $event)" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ChatWorkspace from './ChatWorkspace.vue'
import { createProjectSettingsClient, configReasoning } from '../project-settings.ts'
import type { ReasoningSettings } from '../session-settings.ts'
import { provideModelSelection } from '../model-selection.ts'
import type { FolderRecord } from '../folders-client.ts'
import type { KnowledgeTabRequest } from '../file-workbench.ts'

const props = defineProps<{
  apiBase: string; projectId: string; projectName: string; sessionId: string
  initialFolder?: FolderRecord; openRemote?: boolean; visible: boolean; childSessionId?: string
  knowledgeRequest?: KnowledgeTabRequest
}>()
defineEmits<{ navigate: [id: string, child?: string]; prepared: [id: string]; 'knowledge-navigation': [active: boolean, entryId?: string] }>()
const workspace = ref<InstanceType<typeof ChatWorkspace>>()
const current = ref('')
const defaultReasoning = ref<ReasoningSettings>({})
const options = ref<string[]>([])
const error = ref('')
const loading = ref(false)
let request: AbortController | undefined
provideModelSelection({
  current, defaultReasoning, options, error, loading, disabled: computed(() => loading.value),
  async select(model) {
    if (!model.trim()) { error.value = 'Choose a model for this conversation.'; return }
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
    const [config, models] = await Promise.all([client.load(controller.signal), client.models(controller.signal)])
    if (controller.signal.aborted) return
    current.value = config.agent.model
    defaultReasoning.value = configReasoning(config)
    options.value = models
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load project models. Retry.'
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
defineExpose({ requestSession: (id: string) => workspace.value?.requestSession(id) })
</script>

<style scoped>
.project-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.project-model-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; color: var(--c-error); font-size: 12px; }
.project-model-error a { color: var(--c-text); }
</style>
