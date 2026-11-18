<template>
  <section class="agent-browser" :aria-label="t('Agent types')">
    <div class="agent-browser-layout" :class="{ 'show-detail': agentName || showDetail && requestedAgent }">
      <aside v-if="!agentName" ref="navigation" class="agent-navigation" :aria-label="t('Agent type navigation')">
        <header class="catalog-header">
          <h2>{{ t('Agent types') }} <span class="catalog-count">{{ agentTypes.length }}</span></h2>
          <label class="agent-search">
            <span class="i-lucide-search" aria-hidden="true" />
            <input v-model="agentQuery" type="search" :aria-label="t('Search agent types')" :placeholder="t('Search types')" autocomplete="off" />
          </label>
        </header>
        <div class="agent-list">
          <div v-if="listError" class="agent-error" role="alert">
            <p>{{ listError }}</p><button type="button" class="text-action" @click="loadAgentTypes">{{ t('Retry catalog') }}</button>
          </div>
          <p v-else-if="loadingList" class="agent-note" role="status">{{ t('Loading agent types...') }}</p>
          <p v-else-if="!agentTypes.length" class="agent-note">{{ t('No agent types available.') }}</p>
          <p v-else-if="!filteredGroups.length" class="agent-note" role="status">{{ t('No matching agent types.') }}</p>
          <section v-for="group in filteredGroups" :key="group.source" class="agent-group" :aria-labelledby="`${id}-${group.source}`">
            <h3 :id="`${id}-${group.source}`">{{ group.label }}</h3>
            <button v-for="agent in group.agents" :key="agent.name" type="button" class="agent-item"
              :class="{ active: requestedAgent?.name === agent.name }" :aria-pressed="requestedAgent?.name === agent.name"
              :data-agent-name="agent.name" @click="selectAgent(agent)">
              <span class="agent-item-top"><span class="agent-name">{{ agent.name }}</span><span class="agent-mode">{{ enumLabel(agent.defaultMode ?? t('session')) }}</span></span>
              <span class="agent-desc">{{ agent.description }}</span>
            </button>
          </section>
        </div>
      </aside>

      <div class="agent-detail">
        <DefinitionDetail v-if="requestedAgent" ref="detail" v-model="activeTab" :title="requestedAgent.name"
          :description="requestedAgent.description" :label="t('Agent details')" :tabs="views"
          :source="requestedAgent.definitionMarkdown" source-initially-raw retain-prompt-format :inspection="inspection"
          :inspection-identity="`${requestedAgent.name}:${channel}`" :busy="loadingContext">
          <template #before-heading>
            <button v-if="!agentName" type="button" class="agent-back text-action" @click="backToTypes"><span class="i-lucide-arrow-left" aria-hidden="true" />{{ t('Agent types') }}</button>
          </template>
          <template #overview>
              <section class="detail-overview-section">
                <h3>{{ t('Definition') }}</h3>
                <button v-if="promptDocuments && (requestedAgent.definitionMarkdown ?? requestedAgent.prompt) !== undefined" type="button" class="text-action" @click="openDefinition">{{ t('Open AGENT.md in workspace') }}</button>
                <dl class="detail-facts">
                  <div><dt>{{ t('Source') }}</dt><dd>{{ requestedAgent.source === 'builtin' ? t('Built-in') : t('Workspace') }}</dd></div>
                  <div><dt>{{ t('Default mode') }}</dt><dd>{{ enumLabel(requestedAgent.defaultMode ?? t('session')) }}</dd></div>
                </dl>
              </section>
              <section v-if="hasModelOverrides" class="detail-overview-section">
                <h3>{{ t('Model overrides') }}</h3>
                <dl class="detail-facts">
                  <div v-if="requestedAgent.model"><dt>{{ t('Model') }}</dt><dd><code>{{ requestedAgent.model }}</code></dd></div>
                  <div v-if="requestedAgent.temperature != null"><dt>{{ t('Temperature') }}</dt><dd>{{ requestedAgent.temperature }}</dd></div>
                  <div v-if="requestedAgent.maxTokens != null"><dt>{{ t('Max tokens') }}</dt><dd>{{ requestedAgent.maxTokens }}</dd></div>
                </dl>
                <p class="agent-note">{{ t('Only explicit role overrides are shown. Unset preferences inherit their defaults.') }}</p>
              </section>
              <section class="detail-overview-section">
                <h3>{{ t('Tool filters') }}</h3>
                <dl v-if="requestedAgent.allowedTools !== undefined || requestedAgent.blockedTools !== undefined" class="tool-policies">
                  <div v-if="requestedAgent.allowedTools !== undefined"><dt>{{ t('Allowlist') }}</dt><dd><code v-for="tool in requestedAgent.allowedTools" :key="tool">{{ tool }}</code><span v-if="!requestedAgent.allowedTools.length">{{ t('None listed') }}</span></dd></div>
                  <div v-if="requestedAgent.blockedTools !== undefined"><dt>{{ t('Blocklist') }}</dt><dd><code v-for="tool in requestedAgent.blockedTools" :key="tool">{{ tool }}</code><span v-if="!requestedAgent.blockedTools.length">{{ t('None listed') }}</span></dd></div>
                </dl>
                <p v-else class="agent-note">{{ t('No allowlist or blocklist declared.') }}</p>
                <p class="agent-note">{{ t('These are definition filters, not an existing conversation\'s permissions. Inspect Tools for the resolved preview.') }}</p>
              </section>
              <section class="detail-overview-section preview-links">
                <h3>{{ t('Inspect the preview') }}</h3>
                <p class="agent-note">{{ t('See the tools and assembled system prompt for a selected channel.') }}</p>
                <div><button type="button" class="text-action" @click="openView('tools')">{{ t('View tools') }}<span class="i-lucide-arrow-right" aria-hidden="true" /></button><button type="button" class="text-action" @click="openView('prompt')">{{ t('Read system prompt') }}<span class="i-lucide-arrow-right" aria-hidden="true" /></button></div>
              </section>
          </template>
          <template #source-empty><p class="agent-note">{{ t('This agent definition is unavailable.') }}</p></template>
          <template #inspection-selector>
            <label class="detail-scope">{{ t('Preview channel') }}<UiSelect v-model="channel" :aria-label="t('Preview channel')"><option v-for="ch in channels" :key="ch" :value="ch">{{ ch }}</option></UiSelect></label>
          </template>
          <template #inspection-status>
              <p v-if="loadingContext" class="agent-note" role="status">{{ t('Loading') }} {{ requestedAgent.name }} {{ t('preview for') }} {{ channel }}...</p>
              <div v-if="contextError" class="agent-error" role="alert"><p>{{ contextError }}</p><button type="button" class="text-action" @click="retryContext">{{ t('Retry preview') }}</button></div>
              <p v-if="selected && (loadingContext || contextError || !contextMatchesSelection)" class="previous-context" role="status">{{ t('Showing the previous preview:') }} <strong>{{ selected.name }}</strong> / {{ resolvedChannel }}{{ t('. The requested preview is not available yet.') }}</p>
          </template>
          <template #inspection-footer>
            <p v-if="selected" class="preview-scope"><template v-if="ownerWebPreview">{{ t('Owner Web preview uses current project devices where applicable. This is not a recorded model input.') }} </template>{{ t('Preview only. Conversation history, configuration, bot policy and Work bindings are not inherited.') }}</p>
          </template>
        </DefinitionDetail>
        <div v-else-if="agentName && listError" class="agent-error agent-empty" role="alert"><p>{{ listError }}</p><button class="text-action" type="button" @click="loadAgentTypes">{{ t('Retry catalog') }}</button></div>
        <p v-else class="agent-empty">{{ loadingList ? t('Loading agent types...') : agentName ? t('This agent definition is unavailable.') : t('Select an agent type to inspect.') }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { PromptDocumentsKey } from '../prompt-documents.ts'
import UiSelect from './UiSelect.vue'
import { enumLabel } from '../display-labels.ts'
import { t } from '../i18n.ts'
import { computed, inject, nextTick, onScopeDispose, ref, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiUrl } from '../api-url.ts'
import { parseAgentContext, parseAgentTypes, type AgentTypeMeta } from '../agent-types.ts'
import DefinitionDetail from './DefinitionDetail.vue'
import type { ToolDef } from './ToolsCard.vue'

const props = withDefaults(defineProps<{ apiBase: string; agentName?: string; active?: boolean }>(), { active: true })
const route = useRoute()
const router = useRouter()
const promptDocuments = inject(PromptDocumentsKey, undefined)
function openDefinition() {
  const agent = requestedAgent.value
  const projectId = route.params.projectId
  const prompt = agent?.definitionMarkdown ?? agent?.prompt
  if (!agent || typeof prompt !== 'string' || typeof projectId !== 'string') return
  const source = `${agent.source} / ${agent.name} / AGENT.md${agent.definitionMarkdown === undefined ? ' (definition prompt)' : ''}`
  promptDocuments?.open(projectId, { key: `agent:${agent.source}:${agent.name}`, label: `${agent.name} / AGENT.md`, source,
    prompt, sections: [{ name: source, content: prompt, characters: prompt.length }] })
}
const id = `agents-${useId()}`
const views = computed(() => [...(props.agentName ? [{ id: 'definition', get label() { return 'AGENT.md' } }] as const : []), { id: 'overview', get label() { return t('Overview') } }, { id: 'tools', get label() { return t('Tools') } }, { id: 'prompt', get label() { return t('System prompt') } }] as const)
type AgentView = typeof views.value[number]['id']
const activeTab = ref<AgentView>(props.agentName ? 'definition' : 'overview')
const agentQuery = ref('')
const showDetail = ref(!!route.query.agent)
const navigation = ref<HTMLElement>()
const detail = ref<InstanceType<typeof DefinitionDetail>>()
const channels = ['web', 'discord', 'wechat', 'feishu']
const routeChannel = computed(() => typeof route.query.channel === 'string' && channels.includes(route.query.channel) ? route.query.channel : 'web')
const localChannel = ref(routeChannel.value)
const channel = computed({
  get: () => props.agentName ? localChannel.value : routeChannel.value,
  set: value => {
    if (props.agentName) localChannel.value = value
    else void router.replace({ query: { ...route.query, channel: value } })
  },
})
const agentTypes = ref<AgentTypeMeta[]>([])
const requestedAgent = computed(() => props.agentName ? agentTypes.value.find(agent => agent.name === props.agentName) : agentTypes.value.find(agent => agent.name === route.query.agent) ?? agentTypes.value[0])
const selected = ref<AgentTypeMeta | null>(null)
const renderedSystemPrompt = ref('')
const sections = ref<import('../prompt-sections.ts').PromptSection[]>([])
const resolvedTools = ref<ToolDef[]>([])
const resolvedChannel = ref('')
const ownerWebPreview = ref(false)
const loadingContext = ref(false)
const loadingList = ref(true)
const listError = ref('')
const contextError = ref('')
let listRequest: AbortController | undefined
let contextRequest: AbortController | undefined
const contextMatchesSelection = computed(() => !!selected.value && selected.value.name === requestedAgent.value?.name && resolvedChannel.value === channel.value)
const contextKey = computed(() => `${selected.value?.name}:${resolvedChannel.value}`)
const hasModelOverrides = computed(() => !!requestedAgent.value?.model || requestedAgent.value?.temperature != null || requestedAgent.value?.maxTokens != null)
const filteredGroups = computed(() => {
  const query = agentQuery.value.trim().toLowerCase()
  const matches = agentTypes.value.filter(agent => `${agent.name} ${agent.description}`.toLowerCase().includes(query))
  return ([{ source: 'builtin', label: t('Built-in') }, { source: 'workspace', label: t('Workspace') }] as const)
    .map(group => ({ ...group, agents: matches.filter(agent => agent.source === group.source) })).filter(group => group.agents.length)
})
const inspection = computed(() => selected.value ? {
  key: contextKey.value, tools: resolvedTools.value, prompt: renderedSystemPrompt.value,
  sections: sections.value, copyDisabled: !contextMatchesSelection.value || !!contextError.value,
} : undefined)
function buildUrl(path: string, params?: Record<string, string>) { return apiUrl(props.apiBase, path, params).toString() }
async function loadAgentTypes() {
  listRequest?.abort()
  const request = listRequest = new AbortController()
  loadingList.value = true
  listError.value = ''
  try {
    const response = await fetch(buildUrl('/api/agent-types', props.agentName ? { definition: props.agentName } : undefined), { signal: request.signal })
    if (!response.ok) throw new Error(t('Failed to load agent types ({status}).', { status: response.status }))
    const data = parseAgentTypes(await response.json())
    if (request.signal.aborted) return
    agentTypes.value = data
    if (!props.agentName && requestedAgent.value && route.query.agent !== requestedAgent.value.name) selectAgent(requestedAgent.value, false)
  } catch (cause) {
    if (!request.signal.aborted) {
      listError.value = cause instanceof Error ? cause.message : t('Failed to load agent types.')
      console.error('Failed to load agent types:', cause)
    }
  } finally { if (!request.signal.aborted) loadingList.value = false }
}
async function loadContext(agent: AgentTypeMeta) {
  contextRequest?.abort()
  const request = contextRequest = new AbortController()
  const previewChannel = channel.value
  const query = { channel: previewChannel, ...(previewChannel === 'web' ? { rolePreview: 'owner-web' } : {}) }
  loadingContext.value = true
  contextError.value = ''
  try {
    const response = await fetch(buildUrl(`/api/agent-types/${encodeURIComponent(agent.name)}/context`, query), { signal: request.signal, cache: 'no-store' })
    if (!response.ok) throw new Error(t('Failed to load {name} context ({status}).', { name: agent.name, status: response.status }))
    const data = parseAgentContext(await response.json())
    if (request.signal.aborted) return
    selected.value = agent
    resolvedChannel.value = previewChannel
    ownerWebPreview.value = data.rolePreview === 'owner-web'
    renderedSystemPrompt.value = data.systemPrompt
    sections.value = data.sections
    resolvedTools.value = data.tools
  } catch (cause) {
    if (!request.signal.aborted) {
      contextError.value = cause instanceof Error ? cause.message : t('Failed to load {name} context.', { name: agent.name })
      console.error('Failed to load agent context:', cause)
    }
  } finally { if (!request.signal.aborted) loadingContext.value = false }
}
async function selectAgent(agent: AgentTypeMeta, openDetail = true) {
  if (openDetail) showDetail.value = true
  void router.replace({ query: { ...route.query, agent: agent.name, channel: channel.value } })
  if (openDetail) { await nextTick(); detail.value?.focusHeading() }
}
async function backToTypes() {
  showDetail.value = false
  await nextTick()
  const current = [...(navigation.value?.querySelectorAll<HTMLButtonElement>('[data-agent-name]') ?? [])].find(button => button.dataset.agentName === requestedAgent.value?.name)
  if (current?.getClientRects().length) current.focus({ preventScroll: true })
  else navigation.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
}
function openView(view: AgentView) { void detail.value?.openView(view) }
function retryContext() { if (props.active !== false && requestedAgent.value) void loadContext(requestedAgent.value) }
watch([requestedAgent, channel], () => { if (!props.agentName || activeTab.value === 'tools' || activeTab.value === 'prompt') retryContext() })
watch(activeTab, () => {
  if (props.agentName && (activeTab.value === 'tools' || activeTab.value === 'prompt') && !contextMatchesSelection.value && !loadingContext.value) retryContext()
})
watch(() => [props.apiBase, props.agentName, props.active] as const, () => {
  listRequest?.abort()
  contextRequest?.abort()
  selected.value = null
  agentTypes.value = []
  renderedSystemPrompt.value = ''
  resolvedTools.value = []
  resolvedChannel.value = ''
  ownerWebPreview.value = false
  contextError.value = ''
  loadingContext.value = false
  agentQuery.value = ''
  if (props.active !== false) void loadAgentTypes()
}, { immediate: true })
onScopeDispose(() => { listRequest?.abort(); contextRequest?.abort() })
</script>

<style scoped>
.agent-browser { container: agent-browser / inline-size; height: 100%; min-height: 0; min-width: 0; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
.agent-browser-layout { display: flex; height: 100%; min-height: 0; min-width: 0; }
.agent-navigation { display: flex; flex-direction: column; flex: 0 0 240px; min-height: 0; min-width: 0; border-right: 1px solid var(--c-border); }
.catalog-header { flex-shrink: 0; padding: 20px 16px 16px; }
.catalog-header h2 { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 16px; font-size: 15px; line-height: 20px; font-weight: 600; }
.catalog-count { color: var(--c-text-muted); font-size: 12px; font-weight: 400; }
.agent-search { display: flex; align-items: center; gap: 8px; min-width: 0; border: 1px solid var(--c-control-border); background: var(--c-bg-input); padding: 0 8px; }
.agent-search > span { flex: 0 0 14px; width: 14px; height: 14px; color: var(--c-text-muted); }
.agent-search input { width: 100%; min-width: 0; min-height: 32px; padding: 6px 0; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; outline: none; }
.agent-search:focus-within { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.agent-search input::placeholder { color: var(--c-text-muted); }
.agent-list { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 0 8px 16px; }
.agent-group + .agent-group { margin-top: 24px; }
.agent-group h3 { margin: 0 8px 8px; font-size: 12px; line-height: 20px; font-weight: 500; color: var(--c-text-secondary); }
.agent-item { display: flex; flex-direction: column; width: 100%; gap: 4px; padding: 10px 8px; border: 0; background: transparent; color: var(--c-text); font: inherit; text-align: left; cursor: pointer; }
.agent-item:hover { background: var(--c-bg-muted); }
.agent-item.active { background: var(--c-selection-bg); }
.agent-item.active .agent-name { color: var(--c-primary); font-weight: 600; }
.agent-item-top { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.agent-name { flex: 1; min-width: 0; overflow-wrap: anywhere; font-size: 13px; line-height: 20px; }
.agent-mode { flex-shrink: 0; font-size: 12px; color: var(--c-text-secondary); }
.agent-desc { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; overflow: hidden; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); }
.agent-detail { display: flex; flex: 1; min-width: 0; min-height: 0; }
.agent-back.text-action { display: none; margin-bottom: 20px; }
.tool-policies dt { margin-bottom: 6px; font-size: 12px; line-height: 20px; color: var(--c-text-muted); }
.tool-policies dd { margin: 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
code { font: 12px/1.6 'IBM Plex Mono', ui-monospace, monospace; }
.tool-policies { display: grid; gap: 16px; margin: 0 0 16px; }
.tool-policies dd { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.agent-note, .preview-scope { margin: 12px 0; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.agent-list .agent-note, .agent-list .agent-error { margin-inline: 8px; }
.preview-links > div { display: flex; flex-wrap: wrap; gap: 16px 24px; margin-top: 16px; }
.text-action { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.text-action > span { width: 14px; height: 14px; flex-shrink: 0; }
.previous-context { padding: 12px; background: var(--c-bg-soft); font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.agent-error { font-size: 13px; line-height: 1.6; color: var(--c-error); overflow-wrap: anywhere; }
.agent-error p { margin: 8px 0; }
.preview-scope { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--c-border-soft); }
.agent-empty { margin: 24px 28px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
button:where(:not(.ui-select)):focus-visible, .ui-select:is(:focus-visible, :has(:focus-visible)), [role="tabpanel"]:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.agent-item:focus-visible { outline-offset: -2px; }
@container agent-browser (max-width: 700px) {
  .agent-navigation { flex-basis: 100%; border-right: 0; }
  .agent-browser-layout:not(.show-detail) .agent-detail, .agent-browser-layout.show-detail .agent-navigation { display: none; }
  .agent-back.text-action { display: inline-flex; }
  .text-action { min-height: 44px; }
  .agent-search input { min-height: 44px; font-size: 16px; }
}
@media (pointer: coarse) {
  .text-action { min-height: 44px; }
  .agent-search input { min-height: 44px; font-size: 16px; }
}
</style>
