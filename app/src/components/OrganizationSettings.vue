<template>
  <div class="organization-settings-view">
    <header class="settings-heading">
      <h1>{{ organization?.name ?? 'Organization' }} settings</h1>
      <p>Settings apply only to this organization. Provider connections and Nodes are shared across the app.</p>
      <RouterLink :to="{ name: 'chat', params: { organizationId } }">Back to conversations</RouterLink>
    </header>
    <div class="settings-layout">
      <nav class="settings-navigation" aria-label="Organization settings">
        <RouterLink v-for="item in sections" :key="item.id" :to="{ name: 'organization-settings', params: { organizationId, section: item.id } }" :aria-current="section === item.id ? 'page' : undefined" :class="{ selected: section === item.id }">{{ item.label }}</RouterLink>
      </nav>
      <div class="settings-content">
        <p v-if="loading" role="status">Loading organization settings...</p>
        <div v-if="error" class="settings-error" role="alert"><p>{{ error }}</p><button class="btn" :disabled="loading || saving" @click="load">Retry settings</button></div>
        <p v-if="notice" class="settings-notice" role="status">{{ notice }}</p>
        <form v-show="section === 'general'" @submit.prevent="rename">
          <h2>General</h2>
          <label class="settings-field">Organization name<input v-model="name" required maxlength="100" :disabled="saving || !organization" /></label>
          <label class="settings-field">Home<input :value="config?.agent.workspace ?? ''" readonly aria-describedby="home-description" /></label>
          <p id="home-description" class="settings-help">This organization's memory, skills, learning and scratch chats live here. Renaming does not move its Home.</p>
          <button class="btn" :disabled="saving || !organization || !name.trim()">{{ saving ? 'Saving...' : 'Save name' }}</button>
        </form>
        <form v-show="section === 'models'" @submit.prevent="saveModels">
          <h2>Model defaults</h2>
          <p class="settings-help">New conversations in this organization use these defaults. Open conversations keep their own model choices.</p>
          <label class="settings-field">Default model<input v-model="model" :list="`${fieldId}-models`" required :disabled="saving || !config" placeholder="Model ID, optionally @provider" /></label>
          <datalist :id="`${fieldId}-models`"><option v-for="option in models" :key="option" :value="option" /></datalist>
          <p v-if="modelsError" class="settings-error" role="alert">{{ modelsError }}</p>
          <label class="settings-field">Temperature<input v-model.number="temperature" type="number" step="0.1" required :disabled="saving || !config" /></label>
          <fieldset class="settings-effort" :disabled="saving || !config"><legend>Default effort</legend><ReasoningControls :settings="reasoning" :model="model" :disabled="saving || !config" @change="reasoning = $event" /></fieldset>
          <button class="btn" :disabled="saving || !config || !model.trim()">{{ saving ? 'Saving...' : 'Save model defaults' }}</button>
          <RouterLink class="settings-related" :to="{ name: 'settings', params: { section: 'providers' } }">Manage shared provider connections</RouterLink>
        </form>
        <ChannelsView v-if="botsOpened" v-show="section === 'bots'" :api-base="apiBase" :organization-id="organizationId" :available="available" :active="section === 'bots' && route.name === 'organization-settings' && route.params.organizationId === organizationId" />
        <form v-show="section === 'learning'" @submit.prevent="saveLearning">
          <h2>Learning</h2>
          <p class="settings-help">Reflection, skill encapsulation and identity learning use only this organization's sessions and Home.</p>
          <label v-if="typeof config?.learning?.enabled === 'boolean'" class="settings-checkbox"><input v-model="learningEnabled" type="checkbox" :disabled="saving || !config" />Enable automatic learning</label>
          <label v-for="item in learningFields" :key="item.key" class="settings-field">{{ item.label }} interval (minutes)<input v-model.number="learningIntervals[item.key]" type="number" min="1" max="35791" step="1" required :disabled="saving || !config" /></label>
          <button class="btn" :disabled="saving || !config">{{ saving ? 'Saving...' : 'Save learning settings' }}</button>
          <LearningRuntimeStatus :api-base="apiBase" :organization-id="organizationId" :revision="learningRevision"
            :active="available && section === 'learning' && route.name === 'organization-settings' && route.params.organizationId === organizationId" />
          <RouterLink class="settings-related" :to="{ name: 'chat', params: { organizationId } }">View Self-reflection conversations</RouterLink>
          <RouterLink class="settings-related" :to="{ name: 'agents', params: { organizationId } }">Organization agents and instructions</RouterLink>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useRoute } from 'vue-router'
import ChannelsView from './ChannelsView.vue'
import ReasoningControls from './ReasoningControls.vue'
import LearningRuntimeStatus from './LearningRuntimeStatus.vue'
import { createOrganizationsClient, type OrganizationRecord } from '../organizations.ts'
import { createOrganizationSettingsClient, configReasoning, type OrganizationConfig } from '../organization-settings.ts'
import type { ReasoningSettings } from '../session-settings.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'

const props = defineProps<{ apiBase: string; hostApiBase: string; organizationId: string }>()
defineOptions({ name: 'OrganizationSettings' })
const route = useRoute()
const installation = useInstallationContext()
const available = computed(() => installation.value.mode === 'main' && installation.value.uiScopes.includes('main:admin'))
const fieldId = useId()
const sections = [{ id: 'general', label: 'General' }, { id: 'models', label: 'Models' }, { id: 'bots', label: 'Bots' }, { id: 'learning', label: 'Learning' }]
const section = computed(() => typeof route.params.section === 'string' ? route.params.section : 'general')
const botsOpened = ref(false)
watch(section, value => { if (value === 'bots') botsOpened.value = true }, { immediate: true })
const organization = ref<OrganizationRecord>()
const config = ref<OrganizationConfig>()
const name = ref('')
const model = ref('')
const temperature = ref(0.7)
const reasoning = ref<ReasoningSettings>({})
const models = ref<string[]>([])
const modelsError = ref('')
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const notice = ref('')
const learningEnabled = ref(true)
const learningRevision = ref(0)
const learningFields = [
  { key: 'reflectIntervalMs', label: 'Self-reflection' },
  { key: 'encapsulateIntervalMs', label: 'Skill encapsulation' },
  { key: 'soulIntervalMs', label: 'Identity reflection' },
] as const
const learningIntervals = ref<Record<string, number>>({})
let request: AbortController | undefined
let mutation: AbortController | undefined
function accept(value: OrganizationConfig, section?: 'agent' | 'learning') {
  config.value = value
  if (section !== 'learning') {
    model.value = value.agent.model
    temperature.value = value.agent.temperature
    reasoning.value = configReasoning(value)
  }
  if (section !== 'agent') {
    learningEnabled.value = value.learning?.enabled === true
    for (const item of learningFields) {
      const interval = value.learning?.[item.key]
      learningIntervals.value[item.key] = typeof interval === 'number' ? interval / 60_000 : 0
    }
  }
}
async function load() {
  if (!available.value) { error.value = 'Organization settings require a Main administrator.'; return }
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const client = createOrganizationSettingsClient(props.apiBase)
  try {
    const [catalog, next] = await Promise.all([
      createOrganizationsClient(props.hostApiBase).list(controller.signal), client.load(controller.signal),
    ])
    if (controller.signal.aborted) return
    organization.value = catalog.find(item => item.id === props.organizationId)
    if (!organization.value) throw new Error('This organization is unavailable. Return to conversations and refresh the catalog.')
    name.value = organization.value.name
    accept(next)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not load organization settings. Retry.'
  } finally { if (request === controller) loading.value = false }
  try {
    const next = await client.models(controller.signal)
    if (!controller.signal.aborted) { models.value = next; modelsError.value = '' }
  } catch (cause) {
    if (!controller.signal.aborted) modelsError.value = cause instanceof Error ? cause.message : 'Could not load model choices.'
  }
}
async function mutate(action: (signal: AbortSignal) => Promise<void>) {
  if (saving.value || !available.value) return
  const controller = new AbortController()
  mutation = controller
  saving.value = true
  error.value = notice.value = ''
  try { await action(controller.signal) }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : 'Could not save settings. Retry.' }
  finally { if (mutation === controller) saving.value = false }
}
async function rename() {
  await mutate(async signal => {
    const result = await createOrganizationsClient(props.hostApiBase).save(name.value, props.organizationId, signal)
    if (signal.aborted) return
    organization.value = result
    notice.value = 'Organization name saved.'
    window.dispatchEvent(new CustomEvent('shadow:organizations-changed'))
  })
}
async function saveModels() {
  await mutate(async signal => {
    if (!Number.isFinite(temperature.value)) throw new Error('Enter a valid temperature.')
    const result = await createOrganizationSettingsClient(props.apiBase).save('agent', {
      model: model.value.trim(), temperature: temperature.value, ...reasoning.value,
    }, signal)
    if (signal.aborted) return
    accept(result, 'agent')
    notice.value = 'Model defaults saved for this organization.'
    window.dispatchEvent(new CustomEvent('shadow:config-changed', { detail: { organizationId: props.organizationId } }))
  })
}
async function saveLearning() {
  await mutate(async signal => {
    const patch: Record<string, unknown> = {}
    for (const item of learningFields) {
      const minutes = learningIntervals.value[item.key]
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes * 60_000 > 2_147_483_647) throw new Error('Learning intervals must be whole minutes from 1 to 35791.')
      patch[item.key] = minutes * 60_000
    }
    if (typeof config.value?.learning?.enabled === 'boolean') patch.enabled = learningEnabled.value
    const result = await createOrganizationSettingsClient(props.apiBase).save('learning', patch, signal)
    if (signal.aborted) return
    accept(result, 'learning')
    learningRevision.value++
    notice.value = 'Learning settings saved for this organization.'
    window.dispatchEvent(new CustomEvent('shadow:config-changed', { detail: { organizationId: props.organizationId } }))
  })
}
onMounted(load)
onUnmounted(() => { request?.abort(); mutation?.abort() })
</script>

<style scoped>
.organization-settings-view { width: 100%; max-width: 1240px; min-width: 0; margin: 0 auto; padding: 28px 24px 48px; color: var(--c-text); }
.settings-heading { margin-bottom: 28px; }
.settings-heading h1 { margin: 0 0 8px; font-size: 24px; overflow-wrap: anywhere; }
.settings-heading p, .settings-help { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; max-width: 70ch; }
.settings-heading a, .settings-related { color: var(--c-text); font-size: 13px; text-underline-offset: 3px; }
.settings-layout { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 32px; }
.settings-navigation { display: flex; flex-direction: column; gap: 4px; align-self: start; }
.settings-navigation a { padding: 12px; color: var(--c-text-secondary); text-decoration: none; font-size: 14px; }
.settings-navigation a:hover, .settings-navigation .selected { background: var(--c-bg-muted); color: var(--c-text); }
.settings-navigation .selected { font-weight: 600; }
.settings-content { min-width: 0; }
.settings-content h2 { margin: 0 0 16px; font-size: 20px; }
.settings-field { display: grid; gap: 8px; max-width: 600px; margin: 20px 0; font-size: 13px; }
.settings-field input { width: 100%; min-width: 0; padding: 10px; border: 1px solid var(--c-border); background: var(--c-bg-input); color: var(--c-text); font: inherit; }
.settings-effort { padding: 0; margin: 20px 0; border: 0; max-width: 600px; }
.settings-effort legend { margin-bottom: 8px; font-size: 13px; }
.settings-checkbox { display: flex; align-items: center; gap: 8px; font-size: 13px; }
.settings-related { display: block; margin-top: 16px; }
.settings-error { color: var(--c-error); font-size: 13px; overflow-wrap: anywhere; }
.settings-notice { color: var(--c-text-secondary); font-size: 13px; }
a:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px) {
  .organization-settings-view { padding: 20px 16px 32px; }
  .settings-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .settings-navigation { flex-direction: row; flex-wrap: wrap; border-bottom: 1px solid var(--c-border); }
  .settings-navigation a { min-height: 44px; flex: 1; text-align: center; }
}
</style>
