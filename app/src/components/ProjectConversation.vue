<template>
  <div class="project-conversation">
    <ChatWorkspace ref="workspace" :api-base="apiBase" managed :project-id="projectId" :project-name="projectName"
      :knowledge-request="knowledgeRequest" @knowledge-navigation="(active, entryId) => $emit('knowledge-navigation', active, entryId)"
      @project-navigation="(tab, documentKey) => $emit('project-navigation', tab, documentKey)"
      :inspection="inspection" :keyboard-active="keyboardActive" :session-id="sessionId" :initial-folder="initialFolder" :take-otio-reference="takeOtioReference" :open-remote="openRemote" :visible="visible" :child-session-id="childSessionId" :automation-run="automationRun"
      @navigate="(id, child) => $emit('navigate', id, child)" @prepared="$emit('prepared', $event)" @deleted="$emit('deleted', $event)">
      <template #notice>
        <div v-if="error" class="project-model-error" role="alert">
          {{ error }}
          <button class="btn btn-sm" :disabled="loading" @click="load">{{ t('Retry models') }}</button>
          <RouterLink :to="{ name: 'project-settings', params: { projectId, section: 'models' } }">{{ t('Project models') }}</RouterLink>
          <RouterLink :to="{ name: 'settings', params: { section: 'providers' } }">{{ t('App providers') }}</RouterLink>
        </div>
      </template>
    </ChatWorkspace>
  </div>
</template>

<script setup lang="ts">
import { EditorOwnerKey } from '../editor-groups.ts'
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import { t } from '../i18n.ts'
import type { LabeledInputReference, AttachReferenceResult } from '../workflow-input-references.ts'
import { computed, onActivated, onDeactivated, onMounted, onUnmounted, provide, ref, shallowRef, watch } from 'vue'
import ChatWorkspace from './ChatWorkspace.vue'
import { createProjectSettingsClient, configReasoning, type ProjectConfig } from '../project-settings.ts'
import { scopedModelCatalog } from '../model-catalog.ts'
import { isRecord } from '../folders-sidebar.ts'
import type { ReasoningSettings } from '../session-settings.ts'
import { provideModelSelection, type ProviderInstanceLabel } from '../model-selection.ts'
import type { FolderRecord } from '../folders-client.ts'
import type { KnowledgeTabRequest, ProjectTab } from '../file-workbench.ts'

const livePool = useLiveClientPool()
const props = defineProps<{
  resourceKey?: string; apiBase: string; projectId: string; projectName: string; sessionId: string
  initialFolder?: FolderRecord; takeOtioReference?: () => import('../otio-draft.ts').OtioDraftReference | undefined; openRemote?: boolean; visible: boolean; childSessionId?: string
  knowledgeRequest?: KnowledgeTabRequest
  automationRun?: boolean; inspection?: boolean; keyboardActive?: boolean
}>()
const emit = defineEmits<{ navigate: [id: string, child?: string]; prepared: [id: string]; deleted: [id: string]; 'knowledge-navigation': [active: boolean, entryId?: string]; 'project-navigation': [tab?: ProjectTab, documentKey?: string]; 'dashboard-visible': [visible: boolean] }>()
provide(EditorOwnerKey, props.resourceKey ?? `${props.projectId}:${props.sessionId}`)
const workspace = ref<InstanceType<typeof ChatWorkspace>>()
const current = ref('')
const defaultReasoning = ref<ReasoningSettings>({})
const catalog = shallowRef<ReturnType<typeof scopedModelCatalog>>()
let client: ReturnType<typeof createProjectSettingsClient> | undefined
let unobserveConfig: (() => void) | undefined
let mounted = false, boundBase: string | undefined
const options = computed(() => catalog.value?.value.value?.models ?? [])
const configuredProviders = ref<ProviderInstanceLabel[]>([])
const providers = computed(() => {
  const labels = new Map(configuredProviders.value.map(provider => [provider.id, provider]))
  for (const provider of catalog.value?.value.value?.providers ?? []) labels.set(provider.id, provider)
  return [...labels.values()]
})
const error = ref('')
const loading = ref(false)
let request: AbortController | undefined
let previousDefault: string | undefined
provideModelSelection({
  current, defaultReasoning, options, providers, error, loading, disabled: computed(() => loading.value),
  catalogRevision: computed(() => catalog.value?.revision.value ?? 0),
  async loadCatalog(signal) { await catalog.value?.read(signal) },
  async select(model) {
    if (!model.trim()) { error.value = t('Choose a model for this conversation.'); return }
    current.value = model
    error.value = ''
  },
})
async function load() {
  if (!client) return
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  try {
    await client.load(controller.signal) // The subscription alone publishes configuration.
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load project models. Retry.')
  } finally { if (request === controller) loading.value = false }
}
function accept(config: ProjectConfig | undefined) {
  if (!config) {
    if (current.value === previousDefault) current.value = ''
    previousDefault = undefined
    defaultReasoning.value = {}
    configuredProviders.value = []
    return
  }
  if (!current.value || current.value === previousDefault) current.value = config.agent.model
  previousDefault = config.agent.model
  defaultReasoning.value = configReasoning(config)
  configuredProviders.value = Object.entries(isRecord(config.providers) ? config.providers : {}).flatMap(([id, provider]) =>
    isRecord(provider) ? [{ id, type: typeof provider.type === 'string' ? provider.type : id,
      name: typeof provider.name === 'string' ? provider.name : undefined }] : [])
}
function release() {
  boundBase = undefined
  request?.abort()
  unobserveConfig?.(); unobserveConfig = undefined
  client?.release(); client = undefined
  catalog.value?.release(); catalog.value = undefined
  loading.value = false
  accept(undefined)
}
function bind() {
  const base = mounted && props.visible ? props.apiBase : undefined
  if (base === boundBase) return
  release()
  if (!base) return
  boundBase = base
  client = createProjectSettingsClient(base, fetch, livePool)
  unobserveConfig = client.subscribe(accept)
  catalog.value = scopedModelCatalog(base, livePool)
  void load()
}
function defaultsChanged(event: Event) {
  const id = (event as CustomEvent<{ projectId?: string }>).detail?.projectId
  if (client && (!id || id === props.projectId)) {
    client.invalidate()
    void load()
  }
}
function activate() { mounted = true; bind() }
function deactivate() { mounted = false; release() }
onMounted(() => { activate(); window.addEventListener('shadow:config-changed', defaultsChanged) })
onActivated(activate)
onDeactivated(deactivate)
watch(() => [props.visible, props.apiBase], bind)
onUnmounted(() => { deactivate(); window.removeEventListener('shadow:config-changed', defaultsChanged) })
defineExpose({ canReplaceSidebarTab: () => workspace.value?.canReplaceSidebarTab() ?? false, appendInputReference: (item: LabeledInputReference): AttachReferenceResult => workspace.value?.appendInputReference(item) ?? 'unavailable', focusConversation: () => workspace.value?.focusConversation(), appendDraft: (text: string) => workspace.value?.appendDraft(text), requestSession: (id: string) => workspace.value?.requestSession(id) })
</script>

<style scoped>
.project-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.project-model-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; color: var(--c-error); font-size: 12px; }
.project-model-error a { color: var(--c-text); }
</style>
