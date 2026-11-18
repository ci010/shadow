<template>
  <div v-if="definition" class="bot-definition">
    <DefinitionDetail :key="identity" v-model="tab" :title="`${bot} / ${path}`"
      :description="t('Deployed snapshot / read-only')" :label="t('Bot document views')" :tabs="views"
      :source="error ? undefined : content" :inspection="inspection" :busy="loading"
      :inspection-identity="`${revision}:${scope}`">
      <template #heading-actions>
        <button type="button" class="btn btn-sm refresh" :disabled="loading" @click="refresh">{{ t('Refresh') }}</button>
      </template>
      <template #status>
        <p v-if="loading" role="status">{{ t('Loading entry...') }}</p>
        <p v-if="error" role="alert">{{ error }}</p>
        <p v-else-if="active && inventory?.state.value.value && !revision" role="status">{{ t('This deployed Markdown document is unavailable.') }}</p>
        <p v-else-if="tab !== 'definition' && overview?.status === 'invalid-package'" role="status">{{ t('The deployed package could not be loaded. The original Markdown is still available.') }}</p>
        <p v-else-if="tab !== 'definition' && overview?.status === 'ready' && !overview.scopes.length" role="status">{{ t('No subscribed binding is available for runtime inspection.') }}</p>
      </template>
      <template #overview>
        <section v-if="!error && overview?.status === 'ready'" class="detail-overview-section">
          <h3>{{ t('Definition') }}</h3>
          <dl class="detail-facts">
            <div><dt>{{ t('Mode') }}</dt><dd>{{ t(overview.mode === 'personal' ? 'Personal Bot' : 'Service') }}</dd></div>
            <div v-if="overview.agent"><dt>{{ t('Agent') }}</dt><dd>{{ overview.agent }}</dd></div>
            <div><dt>{{ t('Deployment revision') }}</dt><dd><code>{{ revision }}</code></dd></div>
            <div><dt>{{ t('Runtime scopes') }}</dt><dd>{{ overview.scopes.length }}</dd></div>
          </dl>
        </section>
      </template>
      <template v-if="!error && overview?.status === 'ready' && overview.scopes.length" #inspection-selector>
        <label class="detail-scope">
          {{ t('Runtime scope') }}
          <UiSelect v-model="selection" :aria-label="t('Runtime scope')">
            <option value="" disabled>{{ t('Select a Bot binding') }}</option>
            <option v-for="scope in overview.scopes" :key="scope.key" :value="scope.key">{{ scope.label }}</option>
          </UiSelect>
        </label>
      </template>
      <template #inspection-status>
        <template v-if="!error">
          <p v-if="result === 'disabled'" role="status">{{ t('This Bot binding is disabled.') }}</p>
          <p v-else-if="result === 'unsupported'" role="status">{{ t('Runtime inspection is not supported for this Bot binding.') }}</p>
          <p v-else-if="result === 'unavailable'" role="status">{{ t('Runtime context is unavailable for this scope. Personal Bots require an active verified-owner session.') }}</p>
          <p v-if="runtime" class="context-note">{{ t(runtime.source === 'active-history'
            ? 'Active session system message and tools; not a captured provider request.'
            : 'Binding preview from the runtime policy; no input was admitted. Per-input permissions and provider requests are not reconstructed.') }}</p>
        </template>
      </template>
    </DefinitionDetail>
  </div>
  <article v-else class="bot-document" :aria-label="path">
    <header>
      <h2>{{ bot }} / {{ path }}</h2>
      <p>{{ t('Deployed snapshot / read-only') }}</p>
      <button type="button" class="btn btn-sm" :disabled="loading" @click="refresh">{{ t('Refresh') }}</button>
    </header>
    <p v-if="loading" role="status">{{ t('Loading entry...') }}</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <p v-else-if="active && inventory?.state.value.value && !revision" role="status">{{ t('This deployed Markdown document is unavailable.') }}</p>
    <template v-if="content !== undefined && !error">
      <button type="button" class="btn btn-sm" :aria-pressed="raw" @click="raw = !raw">{{ raw ? t('Show preview') : t('Show source') }}</button>
      <SystemPromptCard :prompt="content" :raw="raw" :show-provenance="false" embedded />
    </template>
  </article>
</template>

<script setup lang="ts">
import { computed, ref, shallowRef, watch } from 'vue'
import { t } from '../i18n.ts'
import { useKnowledgeResourceStore } from '../stores/knowledge.ts'
import { requireResourcePinia } from '../stores/app.ts'
import { useCatalogVisibility } from '../resources/catalog-visibility.ts'
import DefinitionDetail from './DefinitionDetail.vue'
import UiSelect from './UiSelect.vue'
import SystemPromptCard from './SystemPromptCard.vue'

const props = defineProps<{ apiBase: string; projectId: string; bot: string; path: string; active: boolean }>()
const owner = useKnowledgeResourceStore(requireResourcePinia()).owner
const enabled = useCatalogVisibility(() => props.active)
const inventory = shallowRef<ReturnType<typeof owner.bots>>()
const document = shallowRef<ReturnType<typeof owner.botDocument>>()
const metadata = shallowRef<ReturnType<typeof owner.botRuntime>>()
const context = shallowRef<ReturnType<typeof owner.botRuntime>>()
const views = computed(() => [
  { id: 'overview', label: t('Overview') }, { id: 'tools', label: t('Tools') },
  { id: 'prompt', label: t('System prompt') }, { id: 'definition', label: t('Original Markdown') },
] as const)
const tab = ref<typeof views.value[number]['id']>('overview')
const identity = computed(() => JSON.stringify([props.apiBase, props.projectId, props.bot, props.path]))
const selection = ref('')
const raw = ref(false)
const definition = computed(() => props.path === 'BOT.md')
const showSource = computed(() => enabled.value && (!definition.value || tab.value === 'definition'))
const showRuntime = computed(() => enabled.value && definition.value && (tab.value === 'tools' || tab.value === 'prompt'))
const revision = computed(() => inventory.value?.state.value.value?.documents.find(bot => bot.id === props.bot && bot.paths.includes(props.path))?.revision)
const overview = computed(() => metadata.value?.state.value.value)
watch(revision, () => { selection.value = '' })
const scope = computed(() => overview.value?.status === 'ready' &&
  (overview.value.scopes.some(item => item.key === selection.value) ? selection.value
    : overview.value.scopes.length === 1 ? overview.value.scopes[0]?.key : undefined) || undefined)
watch([scope, overview], ([value]) => { selection.value = value ?? '' })
const inspected = computed(() => context.value?.state.value.value)
const result = computed(() => inspected.value?.status === 'ready' ? inspected.value.result : undefined)
const runtime = computed(() => inspected.value?.status === 'ready' ? inspected.value.runtime : undefined)
const loading = computed(() => [inventory.value, document.value, metadata.value, context.value].some(lease => lease?.state.value.loading))
const error = computed(() => inventory.value?.state.value.error || document.value?.state.value.error ||
  (tab.value !== 'definition' && (metadata.value?.state.value.error || context.value?.state.value.error)))
const inspection = computed(() => !error.value && runtime.value ? {
  key: `${revision.value}:${scope.value}`, tools: runtime.value.tools,
  prompt: runtime.value.systemPrompt, sections: runtime.value.sections,
} : undefined)
const content = computed(() => document.value?.state.value.value)
watch(identity, () => {
  tab.value = 'overview'; selection.value = ''; raw.value = false
})
watch(() => [props.apiBase, props.projectId, enabled.value] as const, ([base, project, active], _, cleanup) => {
  inventory.value = undefined
  if (!active) return
  const lease = inventory.value = owner.bots(base, project)
  cleanup(lease.release)
}, { immediate: true })
watch(() => [props.apiBase, props.projectId, props.bot, props.path, revision.value, showSource.value] as const, ([base, project, bot, path, revision, active], _, cleanup) => {
  document.value = undefined
  if (!active || !revision) return
  const lease = document.value = owner.botDocument(base, project, bot, path, revision)
  cleanup(lease.release)
}, { immediate: true })
watch(() => [props.apiBase, props.projectId, props.bot, revision.value, enabled.value && definition.value] as const,
  ([base, project, bot, revision, active], _, cleanup) => {
    metadata.value = undefined
    if (!active || !revision) return
    const lease = metadata.value = owner.botRuntime(base, project, bot, revision)
    cleanup(lease.release)
  }, { immediate: true })
watch(() => [props.apiBase, props.projectId, props.bot, revision.value, scope.value,
  showRuntime.value] as const,
  ([base, project, bot, revision, scope, active], _, cleanup) => {
    context.value = undefined
    if (!active || !revision || scope === undefined) return
    const lease = context.value = owner.botRuntime(base, project, bot, revision, scope)
    cleanup(lease.release)
  }, { immediate: true })
async function refresh() {
  const previous = [document.value, metadata.value, context.value]
  await inventory.value?.refresh()
  await Promise.all([document.value, metadata.value, context.value].map(lease => lease && previous.includes(lease) ? lease.refresh() : undefined))
}
</script>

<style scoped>
.bot-document { flex: 1; min-height: 0; overflow: auto; padding: 16px; background: var(--c-bg-card); color: var(--c-text); }
.bot-document header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid var(--c-border); }
.bot-document h2 { font-size: 15px; font-weight: 600; overflow-wrap: anywhere; }
.bot-document header p { color: var(--c-text-secondary); font-size: 12px; }
.bot-document button { margin-inline-end: 8px; }
.bot-definition { container: agent-browser / inline-size; display: flex; flex: 1; min-height: 0; min-width: 0; }
.refresh { margin-top: 12px; }
.context-note { margin-block: 12px; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
[role='alert'] { color: var(--c-error); }
</style>
