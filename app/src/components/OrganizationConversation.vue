<template>
  <div class="organization-conversation">
    <div v-if="error" class="organization-model-error" role="alert">
      {{ error }}
      <button class="btn btn-sm" :disabled="loading" @click="load">Retry models</button>
      <RouterLink :to="{ name: 'organization-settings', params: { organizationId, section: 'models' } }">Organization models</RouterLink>
      <RouterLink :to="{ name: 'settings', params: { section: 'providers' } }">App providers</RouterLink>
    </div>
    <ChatWorkspace ref="workspace" :api-base="apiBase" managed :organization-id="organizationId" :organization-name="organizationName"
      :session-id="sessionId" :initial-project="initialProject" :open-remote="openRemote" :visible="visible" :child-session-id="childSessionId"
      @navigate="(id, child) => $emit('navigate', id, child)" @prepared="$emit('prepared', $event)" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import ChatWorkspace from './ChatWorkspace.vue'
import { createOrganizationSettingsClient } from '../organization-settings.ts'
import { provideModelSelection } from '../model-selection.ts'
import type { ProjectRecord } from '../projects-client.ts'

const props = defineProps<{
  apiBase: string; organizationId: string; organizationName: string; sessionId: string
  initialProject?: ProjectRecord; openRemote?: boolean; visible: boolean; childSessionId?: string
}>()
defineEmits<{ navigate: [id: string, child?: string]; prepared: [id: string] }>()
const workspace = ref<InstanceType<typeof ChatWorkspace>>()
const current = ref('')
const options = ref<string[]>([])
const error = ref('')
const loading = ref(false)
let chosen = false
let request: AbortController | undefined
provideModelSelection({
  current, options, error, loading, disabled: computed(() => loading.value),
  async select(model) {
    if (!model.trim()) { error.value = 'Choose a model for this conversation.'; return }
    current.value = model
    chosen = true
    error.value = ''
  },
})
async function load() {
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const client = createOrganizationSettingsClient(props.apiBase)
  try {
    const [config, models] = await Promise.all([client.load(controller.signal), client.models(controller.signal)])
    if (controller.signal.aborted) return
    if (!chosen && !current.value) current.value = config.agent.model
    options.value = models
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load organization models. Retry.'
  } finally { if (request === controller) loading.value = false }
}
onMounted(load)
onUnmounted(() => request?.abort())
defineExpose({ requestSession: (id: string) => workspace.value?.requestSession(id) })
</script>

<style scoped>
.organization-conversation { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; }
.organization-model-error { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; padding: 8px 16px; color: var(--c-error); font-size: 12px; }
.organization-model-error a { color: var(--c-text); }
</style>
