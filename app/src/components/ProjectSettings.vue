<template>
  <div class="project-settings-view">
    <header class="settings-heading">
      <h1>{{ project?.name ?? t('Project') }} {{ t('settings') }}</h1>
      <p>{{ t('Settings apply only to this project. Provider connections and Nodes are shared across the app.') }}</p>
    </header>
    <div class="settings-layout">
      <nav class="settings-navigation" :aria-label="t('Project settings')">
        <RouterLink v-for="item in sections" :key="item.id" :to="{ name: 'project-settings', params: { projectId, section: item.id } }" :aria-current="section === item.id ? 'page' : undefined" :class="{ selected: section === item.id }">{{ item.label }}</RouterLink>
      </nav>
      <div class="settings-content">
        <p v-if="loading" role="status">{{ t('Loading project settings...') }}</p>
        <div v-if="error" class="settings-error" role="alert"><p>{{ error }}</p><button class="btn" :disabled="loading || saving" @click="load">{{ t('Retry settings') }}</button></div>
        <p v-if="notice" class="settings-notice" role="status">{{ notice }}</p>
        <form v-show="section === 'general'" @submit.prevent="rename">
          <h2>{{ t('General') }}</h2>
          <label class="settings-field">{{ t('Project name') }}<input v-model="name" required maxlength="100" :disabled="saving || !project" /></label>
          <label class="settings-field">{{ t('Home') }}<input :value="config?.agent.workspace ?? ''" readonly aria-describedby="home-description" /></label>
          <p id="home-description" class="settings-help">{{ t('This project\'s memory, skills, learning and scratch chats live here. Renaming does not move its Home.') }}</p>
          <button class="btn primary" :disabled="saving || !project || !name.trim()">{{ saving ? t('Saving...') : t('Save name') }}</button>
        </form>
        <section v-if="section === 'general' && project" class="project-danger">
          <h2>{{ t('Delete project') }}</h2>
          <p class="settings-help">{{ project.id === 'default' ? t('The Default project is required and cannot be deleted.') : t('Permanently delete this project and its Home data. Working folders and their files are kept.') }}</p>
          <button v-if="available && project.id !== 'default'" type="button" class="btn delete-project" :disabled="saving" @click="deleting = true">{{ t('Delete project') }}</button>
        </section>
        <section v-if="config && modelsOpened" v-show="section === 'models'">
          <ModelDefaultsForm :api-base="apiBase" scope="project" :project-id="projectId" />
          <RouterLink class="settings-related" :to="{ name: 'settings', params: { section: 'providers' } }">{{ t('Manage shared provider connections') }}</RouterLink>
          <RouterLink class="settings-related" :to="{ name: 'settings', params: { section: 'models' } }">{{ t('App model defaults') }}</RouterLink>
        </section>
        <div v-if="section === 'agents'" class="settings-agents"><AgentsTab :api-base="apiBase" /></div>
        <ChannelsView v-if="botsOpened" v-show="section === 'bots'" :api-base="apiBase" :project-id="projectId" :available="available" :active="section === 'bots' && route.name === 'project-settings' && route.params.projectId === projectId"
          :review-bot-id="typeof route.query.discordBot === 'string' ? route.query.discordBot : undefined"
          :requested-review-id="typeof route.query.discordReview === 'string' ? route.query.discordReview : undefined" />
        <form v-show="section === 'learning'" @submit.prevent="saveLearning">
          <h2>{{ t('Learning') }}</h2>
          <p class="settings-help">{{ t('Reflection, skill encapsulation and identity learning use only this project\'s sessions and Home.') }}</p>
          <label v-if="typeof config?.learning?.enabled === 'boolean'" class="settings-checkbox"><input v-model="learningEnabled" type="checkbox" :disabled="saving || !config" />{{ t('Enable automatic learning') }}</label>
          <label v-for="item in learningFields" :key="item.key" class="settings-field">{{ item.label }} {{ t('interval (minutes)') }}<input v-model.number="learningIntervals[item.key]" type="number" min="1" max="35791" step="1" required :disabled="saving || !config" /></label>
          <button class="btn primary" :disabled="saving || !config">{{ saving ? t('Saving...') : t('Save learning settings') }}</button>
          <LearningRuntimeStatus :api-base="apiBase" :project-id="projectId" :revision="learningRevision"
            :active="available && section === 'learning' && route.name === 'project-settings' && route.params.projectId === projectId" />
          <RouterLink class="settings-related" :to="{ name: 'chat', params: { projectId } }">{{ t('View Self-reflection conversations') }}</RouterLink>
          <RouterLink class="settings-related" :to="{ name: 'project-settings', params: { projectId, section: 'agents' } }">{{ t('Project agents and instructions') }}</RouterLink>
        </form>
      </div>
      <ProjectDeleteDialog v-if="deleting && project" :api-base="hostApiBase" :project="project" @close="deleting = false" @deleted="projectDeleted" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { useLiveClientPool } from '../composables/useLiveClient.ts'
import { t } from '../i18n.ts'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import AgentsTab from './AgentsTab.vue'
import ChannelsView from './ChannelsView.vue'
import ModelDefaultsForm from './ModelDefaultsForm.vue'
import LearningRuntimeStatus from './LearningRuntimeStatus.vue'
import ProjectDeleteDialog from './ProjectDeleteDialog.vue'
import { createProjectsClient, type ProjectRecord } from '../projects.ts'
import { createProjectSettingsClient, type ProjectConfig } from '../project-settings.ts'
import { useInstallationContext } from '../composables/useInstallationContext.ts'

const livePool = useLiveClientPool()
const props = defineProps<{ apiBase: string; hostApiBase: string; projectId: string }>()
defineOptions({ name: 'ProjectSettings' })
const route = useRoute()
const installation = useInstallationContext()
const available = computed(() => installation.value.mode !== 'child' || installation.value.mainWorkspace === true || installation.value.mainConnection === 'connected')
const sections = [{ id: 'general', get label() { return t('General') } }, { id: 'models', get label() { return t('Models') } }, { id: 'agents', get label() { return t('Agents') } }, { id: 'bots', get label() { return t('Bots') } }, { id: 'learning', get label() { return t('Learning') } }]
const section = computed(() => typeof route.params.section === 'string' ? route.params.section : 'general')
const botsOpened = ref(false)
const modelsOpened = ref(false)
watch(section, value => { if (value === 'models') modelsOpened.value = true }, { immediate: true })
watch(section, value => { if (value === 'bots') botsOpened.value = true }, { immediate: true })
const project = ref<ProjectRecord>()
const config = ref<ProjectConfig>()
const name = ref('')
const loading = ref(false)
const saving = ref(false)
const deleting = ref(false)
const error = ref('')
const notice = ref('')
const learningEnabled = ref(true)
const learningRevision = ref(0)
const learningFields = [
  { key: 'reflectIntervalMs', get label() { return t('Self-reflection') } },
  { key: 'encapsulateIntervalMs', get label() { return t('Skill encapsulation') } },
  { key: 'soulIntervalMs', get label() { return t('Identity reflection') } },
] as const
const learningIntervals = ref<Record<string, number>>({})
let request: AbortController | undefined
let mutation: AbortController | undefined
function accept(value: ProjectConfig, section?: 'agent' | 'learning') {
  config.value = value
  if (section !== 'agent') {
    learningEnabled.value = value.learning?.enabled === true
    for (const item of learningFields) {
      const interval = value.learning?.[item.key]
      learningIntervals.value[item.key] = typeof interval === 'number' ? interval / 60_000 : 0
    }
  }
}
async function load() {
  if (!available.value) { error.value = t('Main is unavailable'); return }
  request?.abort()
  const controller = new AbortController()
  request = controller
  loading.value = true
  error.value = ''
  const client = createProjectSettingsClient(props.apiBase, fetch, livePool)
  try {
    const [catalog, next] = await Promise.all([
      createProjectsClient(props.hostApiBase).list(controller.signal), client.load(controller.signal),
    ])
    if (controller.signal.aborted) return
    project.value = catalog.find(item => item.id === props.projectId)
    if (!project.value) throw new Error(t('This project is unavailable. Return to conversations and refresh the catalog.'))
    name.value = project.value.name
    accept(next)
  } catch (cause) {
    if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not load project settings. Retry.')
  } finally { if (request === controller) loading.value = false }
}
async function mutate(action: (signal: AbortSignal) => Promise<void>) {
  if (saving.value || !available.value) return
  const controller = new AbortController()
  mutation = controller
  saving.value = true
  error.value = notice.value = ''
  try { await action(controller.signal) }
  catch (cause) { if (!controller.signal.aborted) error.value = cause instanceof Error ? cause.message : t('Could not save settings. Retry.') }
  finally { if (mutation === controller) saving.value = false }
}
async function rename() {
  await mutate(async signal => {
    const result = await createProjectsClient(props.hostApiBase).save(name.value, props.projectId, signal)
    if (signal.aborted) return
    project.value = result
    notice.value = t('Project name saved.')
    window.dispatchEvent(new CustomEvent('shadow:projects-changed'))
  })
}
function projectDeleted(projectId: string) {
  deleting.value = false
  window.dispatchEvent(new CustomEvent('shadow:project-deleted', { detail: { projectId } }))
}
async function saveLearning() {
  await mutate(async signal => {
    const patch: Record<string, unknown> = {}
    for (const item of learningFields) {
      const minutes = learningIntervals.value[item.key]
      if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes * 60_000 > 2_147_483_647) throw new Error(t('Learning intervals must be whole minutes from 1 to 35791.'))
      patch[item.key] = minutes * 60_000
    }
    if (typeof config.value?.learning?.enabled === 'boolean') patch.enabled = learningEnabled.value
    const result = await createProjectSettingsClient(props.apiBase, fetch, livePool).save('learning', patch, signal)
    if (signal.aborted) return
    accept(result, 'learning')
    learningRevision.value++
    notice.value = t('Learning settings saved for this project.')
    window.dispatchEvent(new CustomEvent('shadow:config-changed', { detail: { projectId: props.projectId } }))
  })
}
onMounted(load)
onUnmounted(() => { request?.abort(); mutation?.abort() })
</script>

<style scoped>
.project-settings-view { width: 100%; max-width: 1240px; min-width: 0; margin: 0 auto; padding: 28px 24px 48px; color: var(--c-text); }
.settings-heading { margin-bottom: 28px; }
.settings-heading h1 { margin: 0 0 8px; font-size: 24px; overflow-wrap: anywhere; }
.settings-heading p, .settings-help { color: var(--c-text-secondary); font-size: 14px; line-height: 1.6; max-width: 70ch; }
.settings-related { color: var(--c-text); font-size: 13px; text-underline-offset: 3px; }
.settings-layout { display: grid; grid-template-columns: 160px minmax(0, 1fr); gap: 32px; }
.settings-navigation { display: flex; flex-direction: column; gap: 4px; align-self: start; }
.settings-navigation a { padding: 12px; color: var(--c-text-secondary); text-decoration: none; font-size: 14px; }
.settings-navigation a:hover, .settings-navigation .selected { background: var(--c-bg-muted); color: var(--c-text); }
.settings-navigation .selected { font-weight: 600; }
.settings-agents { height: max(520px, calc(100dvh - 230px)); min-width: 0; }
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
.project-danger { margin-top: 40px; padding-top: 24px; border-top: 1px solid var(--c-border); }
.delete-project { color: var(--c-error); border-color: var(--c-error); }
a:focus-visible, input:focus-visible, button:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
@media (max-width: 700px) {
  .project-settings-view { padding: 20px 16px 32px; }
  .settings-layout { grid-template-columns: minmax(0, 1fr); gap: 24px; }
  .settings-navigation { flex-direction: row; flex-wrap: wrap; border-bottom: 1px solid var(--c-border); }
  .settings-navigation a { min-height: 44px; flex: 1; text-align: center; }
}
</style>
