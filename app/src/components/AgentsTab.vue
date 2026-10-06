<template>
  <section class="agent-browser" aria-label="Agent types">
    <div class="agent-browser-layout" :class="{ 'show-detail': showDetail && requestedAgent }">
      <aside ref="navigation" class="agent-navigation" aria-label="Agent type navigation">
        <header class="catalog-header">
          <h2>Agent types <span class="catalog-count">{{ agentTypes.length }}</span></h2>
          <label class="agent-search">
            <span class="i-lucide-search" aria-hidden="true" />
            <input v-model="agentQuery" type="search" aria-label="Search agent types" placeholder="Search types" autocomplete="off" />
          </label>
        </header>
        <div class="agent-list">
          <div v-if="listError" class="agent-error" role="alert">
            <p>{{ listError }}</p><button type="button" class="text-action" @click="loadAgentTypes">Retry catalog</button>
          </div>
          <p v-else-if="loadingList" class="agent-note" role="status">Loading agent types...</p>
          <p v-else-if="!agentTypes.length" class="agent-note">No agent types available.</p>
          <p v-else-if="!filteredGroups.length" class="agent-note" role="status">No matching agent types.</p>
          <section v-for="group in filteredGroups" :key="group.source" class="agent-group" :aria-labelledby="`${id}-${group.source}`">
            <h3 :id="`${id}-${group.source}`">{{ group.label }}</h3>
            <button v-for="agent in group.agents" :key="agent.name" type="button" class="agent-item"
              :class="{ active: requestedAgent?.name === agent.name }" :aria-pressed="requestedAgent?.name === agent.name"
              :data-agent-name="agent.name" @click="selectAgent(agent)">
              <span class="agent-item-top"><span class="agent-name">{{ agent.name }}</span><span class="agent-mode">{{ agent.defaultMode ?? 'session' }}</span></span>
              <span class="agent-desc">{{ agent.description }}</span>
            </button>
          </section>
        </div>
      </aside>

      <div ref="detail" class="agent-detail">
        <template v-if="requestedAgent">
          <header class="agent-heading">
            <button type="button" class="agent-back text-action" @click="backToTypes"><span class="i-lucide-arrow-left" aria-hidden="true" />Agent types</button>
            <h2 ref="heading" tabindex="-1">{{ requestedAgent.name }}</h2>
            <p>{{ requestedAgent.description }}</p>
          </header>
          <div ref="tablist" class="agent-tabs" role="tablist" aria-label="Agent details">
            <button v-for="(tab, index) in views" :id="`${id}-${tab.id}-tab`" :key="tab.id" type="button" role="tab"
              :aria-controls="`${id}-${tab.id}-panel`" :aria-selected="activeTab === tab.id" :tabindex="activeTab === tab.id ? 0 : -1"
              @click="activeTab = tab.id" @keydown="tabKeydown($event, index)">
              {{ tab.label }}<span v-if="tab.id === 'tools' && contextMatchesSelection" class="tab-count">{{ resolvedTools.length }}</span>
            </button>
          </div>

          <div class="agent-content">
            <section v-show="activeTab === 'overview'" :id="`${id}-overview-panel`" class="agent-overview" role="tabpanel" :aria-labelledby="`${id}-overview-tab`" tabindex="0">
              <section class="overview-section">
                <h3>Definition</h3>
                <dl class="agent-facts">
                  <div><dt>Source</dt><dd>{{ requestedAgent.source === 'builtin' ? 'Built-in' : 'Workspace' }}</dd></div>
                  <div><dt>Default mode</dt><dd>{{ requestedAgent.defaultMode ?? 'session' }}</dd></div>
                </dl>
              </section>
              <section v-if="hasModelOverrides" class="overview-section">
                <h3>Model overrides</h3>
                <dl class="agent-facts">
                  <div v-if="requestedAgent.model"><dt>Model</dt><dd><code>{{ requestedAgent.model }}</code></dd></div>
                  <div v-if="requestedAgent.temperature != null"><dt>Temperature</dt><dd>{{ requestedAgent.temperature }}</dd></div>
                  <div v-if="requestedAgent.maxTokens != null"><dt>Max tokens</dt><dd>{{ requestedAgent.maxTokens }}</dd></div>
                </dl>
                <p class="agent-note">Only explicit role overrides are shown. Unset preferences inherit their defaults.</p>
              </section>
              <section class="overview-section">
                <h3>Tool filters</h3>
                <dl v-if="requestedAgent.allowedTools !== undefined || requestedAgent.blockedTools !== undefined" class="tool-policies">
                  <div v-if="requestedAgent.allowedTools !== undefined"><dt>Allowlist</dt><dd><code v-for="tool in requestedAgent.allowedTools" :key="tool">{{ tool }}</code><span v-if="!requestedAgent.allowedTools.length">None listed</span></dd></div>
                  <div v-if="requestedAgent.blockedTools !== undefined"><dt>Blocklist</dt><dd><code v-for="tool in requestedAgent.blockedTools" :key="tool">{{ tool }}</code><span v-if="!requestedAgent.blockedTools.length">None listed</span></dd></div>
                </dl>
                <p v-else class="agent-note">No allowlist or blocklist declared.</p>
                <p class="agent-note">These are definition filters, not an existing conversation's permissions. Inspect Tools for the resolved preview.</p>
              </section>
              <section class="overview-section preview-links">
                <h3>Inspect the preview</h3>
                <p class="agent-note">See the tools and assembled system prompt for a selected channel.</p>
                <div><button type="button" class="text-action" @click="openView('tools')">View tools<span class="i-lucide-arrow-right" aria-hidden="true" /></button><button type="button" class="text-action" @click="openView('prompt')">Read system prompt<span class="i-lucide-arrow-right" aria-hidden="true" /></button></div>
              </section>
            </section>

            <template v-if="activeTab !== 'overview'">
              <div class="preview-toolbar">
                <label class="preview-channel">Preview channel<select v-model="channel" aria-label="Preview channel"><option v-for="ch in channels" :key="ch" :value="ch">{{ ch }}</option></select></label>
                <div v-if="activeTab === 'prompt'" class="prompt-format" role="group" aria-label="System prompt format">
                  <button type="button" :aria-pressed="!rawPrompt" @click="rawPrompt = false">Read</button><button type="button" :aria-pressed="rawPrompt" @click="rawPrompt = true">Raw</button>
                </div>
                <button type="button" class="preview-copy" :disabled="copyBusy || !contextMatchesSelection || loadingContext || !!contextError || activeTab === 'tools' && !resolvedTools.length || activeTab === 'prompt' && !renderedSystemPrompt" @click="copy">
                  <span :class="copied ? 'i-lucide-check' : 'i-lucide-copy'" aria-hidden="true" />{{ copied ? 'Copied' : activeTab === 'tools' ? 'Copy JSON' : 'Copy prompt' }}
                </button>
              </div>
              <p v-if="loadingContext" class="agent-note" role="status">Loading {{ requestedAgent.name }} preview for {{ channel }}...</p>
              <div v-if="contextError" class="agent-error" role="alert"><p>{{ contextError }}</p><button type="button" class="text-action" @click="retryContext">Retry preview</button></div>
              <p v-if="selected && (loadingContext || contextError || !contextMatchesSelection)" class="previous-context" role="status">Showing the previous preview: <strong>{{ selected.name }}</strong> / {{ resolvedChannel }}. The requested preview is not available yet.</p>
              <p v-if="copyError" class="agent-error" role="alert">{{ copyError }}</p>
              <p v-if="copied" class="copy-feedback" role="status">{{ activeTab === 'tools' ? 'Tools JSON copied.' : 'System prompt copied.' }}</p>
            </template>
            <section v-show="activeTab === 'tools'" :id="`${id}-tools-panel`" role="tabpanel" :aria-labelledby="`${id}-tools-tab`" :aria-busy="loadingContext" tabindex="0">
              <template v-if="activeTab === 'tools' && selected">
                <label class="agent-search tool-search"><span class="i-lucide-search" aria-hidden="true" /><input v-model="toolQuery" type="search" aria-label="Search tools" placeholder="Search tools" autocomplete="off" /></label>
                <ToolsCard :key="contextKey" :tools="filteredTools" embedded :empty-message="toolQuery.trim() ? 'No matching tools.' : 'No tools available.'" />
              </template>
            </section>
            <section v-show="activeTab === 'prompt'" :id="`${id}-prompt-panel`" role="tabpanel" :aria-labelledby="`${id}-prompt-tab`" :aria-busy="loadingContext" tabindex="0">
              <template v-if="activeTab === 'prompt' && selected">
                <p v-if="renderedSystemPrompt" class="prompt-estimate">Approx. {{ Math.round(renderedSystemPrompt.length / 4).toLocaleString() }} tokens</p>
                <SystemPromptCard :key="contextKey" :prompt="renderedSystemPrompt" embedded :raw="rawPrompt" empty-message="No system prompt." />
              </template>
            </section>
            <p v-if="activeTab !== 'overview' && selected" class="preview-scope">Preview only. Conversation history, configuration, bot policy and Work bindings are not inherited.</p>
          </div>
        </template>
        <p v-else class="agent-empty">{{ loadingList ? 'Loading agent types...' : 'Select an agent type to inspect.' }}</p>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { apiUrl } from '../api-url.ts'
import { parseAgentContext, parseAgentTypes, type AgentTypeMeta } from '../agent-types.ts'
import { useTextCopy } from '../composables/useTextCopy.ts'
import SystemPromptCard from './SystemPromptCard.vue'
import ToolsCard, { type ToolDef } from './ToolsCard.vue'

const props = defineProps<{ apiBase: string }>()
const route = useRoute()
const router = useRouter()
const id = `agents-${useId()}`
const views = [{ id: 'overview', label: 'Overview' }, { id: 'tools', label: 'Tools' }, { id: 'prompt', label: 'System prompt' }] as const
type AgentView = typeof views[number]['id']
const activeTab = ref<AgentView>('overview')
const agentQuery = ref('')
const toolQuery = ref('')
const rawPrompt = ref(false)
const showDetail = ref(!!route.params.agentName)
const navigation = ref<HTMLElement>()
const detail = ref<HTMLElement>()
const heading = ref<HTMLElement>()
const tablist = ref<HTMLElement>()
const channels = ['heartbeat', 'web', 'discord', 'wechat', 'feishu']
const channel = computed({
  get: () => typeof route.query.channel === 'string' && channels.includes(route.query.channel) ? route.query.channel : 'heartbeat',
  set: value => { void router.replace({ query: { ...route.query, channel: value } }) },
})
const agentTypes = ref<AgentTypeMeta[]>([])
const requestedAgent = computed(() => agentTypes.value.find(agent => agent.name === route.params.agentName) ?? agentTypes.value[0])
const selected = ref<AgentTypeMeta | null>(null)
const renderedSystemPrompt = ref('')
const resolvedTools = ref<ToolDef[]>([])
const resolvedChannel = ref('')
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
  return ([{ source: 'builtin', label: 'Built-in' }, { source: 'workspace', label: 'Workspace' }] as const)
    .map(group => ({ ...group, agents: matches.filter(agent => agent.source === group.source) })).filter(group => group.agents.length)
})
const filteredTools = computed(() => {
  const query = toolQuery.value.trim().toLowerCase()
  return resolvedTools.value.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(query))
})
const copyText = computed(() => activeTab.value === 'tools' ? JSON.stringify(resolvedTools.value, null, 2) : renderedSystemPrompt.value)
const { copied, busy: copyBusy, error: copyError, copy, reset: resetCopy } = useTextCopy(copyText)
function buildUrl(path: string, params?: Record<string, string>) { return apiUrl(props.apiBase, path, params).toString() }
async function loadAgentTypes() {
  listRequest?.abort()
  const request = listRequest = new AbortController()
  loadingList.value = true
  listError.value = ''
  try {
    const response = await fetch(buildUrl('/debug/agent-types'), { signal: request.signal })
    if (!response.ok) throw new Error(`Failed to load agent types (${response.status}).`)
    const data = parseAgentTypes(await response.json())
    if (request.signal.aborted) return
    agentTypes.value = data
    if (requestedAgent.value && route.params.agentName !== requestedAgent.value.name) selectAgent(requestedAgent.value, false)
  } catch (cause) {
    if (!request.signal.aborted) {
      listError.value = cause instanceof Error ? cause.message : 'Failed to load agent types.'
      console.error('Failed to load agent types:', cause)
    }
  } finally { if (!request.signal.aborted) loadingList.value = false }
}
async function loadContext(agent: AgentTypeMeta) {
  contextRequest?.abort()
  const request = contextRequest = new AbortController()
  const previewChannel = channel.value
  loadingContext.value = true
  contextError.value = ''
  try {
    const response = await fetch(buildUrl(`/debug/agent-types/${encodeURIComponent(agent.name)}/context`, { channel: previewChannel }), { signal: request.signal })
    if (!response.ok) throw new Error(`Failed to load ${agent.name} context (${response.status}).`)
    const data = parseAgentContext(await response.json())
    if (request.signal.aborted) return
    selected.value = agent
    resolvedChannel.value = previewChannel
    renderedSystemPrompt.value = data.systemPrompt
    resolvedTools.value = data.tools
  } catch (cause) {
    if (!request.signal.aborted) {
      contextError.value = cause instanceof Error ? cause.message : `Failed to load ${agent.name} context.`
      console.error('Failed to load agent context:', cause)
    }
  } finally { if (!request.signal.aborted) loadingContext.value = false }
}
async function selectAgent(agent: AgentTypeMeta, openDetail = true) {
  if (openDetail) showDetail.value = true
  void router.replace({ name: 'agents', params: { ...route.params, agentName: agent.name }, query: { ...route.query, channel: channel.value } })
  if (openDetail) { await nextTick(); detail.value?.scrollTo({ top: 0 }); heading.value?.focus({ preventScroll: true }) }
}
async function backToTypes() {
  showDetail.value = false
  await nextTick()
  const current = [...(navigation.value?.querySelectorAll<HTMLButtonElement>('[data-agent-name]') ?? [])].find(button => button.dataset.agentName === requestedAgent.value?.name)
  if (current?.getClientRects().length) current.focus({ preventScroll: true })
  else navigation.value?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true })
}
async function openView(view: AgentView) {
  activeTab.value = view
  await nextTick()
  tablist.value?.querySelector<HTMLButtonElement>('[aria-selected="true"]')?.focus({ preventScroll: true })
}
async function tabKeydown(event: KeyboardEvent, index: number) {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? views.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + views.length) % views.length
  await openView(views[next]!.id)
}
function retryContext() { if (requestedAgent.value) void loadContext(requestedAgent.value) }
watch([requestedAgent, channel], () => { toolQuery.value = ''; resetCopy(); retryContext() })
watch(activeTab, resetCopy)
watch(() => props.apiBase, () => {
  contextRequest?.abort()
  selected.value = null
  agentTypes.value = []
  renderedSystemPrompt.value = ''
  resolvedTools.value = []
  resolvedChannel.value = ''
  contextError.value = ''
  loadingContext.value = false
  agentQuery.value = ''
  void loadAgentTypes()
})
onMounted(loadAgentTypes)
onUnmounted(() => { listRequest?.abort(); contextRequest?.abort() })
</script>

<style scoped>
.agent-browser { container: agent-browser / inline-size; height: 100%; min-height: 0; min-width: 0; border: 1px solid var(--c-border); background: var(--c-bg-card); color: var(--c-text); }
.agent-browser-layout { display: flex; height: 100%; min-height: 0; min-width: 0; }
.agent-navigation { display: flex; flex-direction: column; flex: 0 0 240px; min-height: 0; min-width: 0; border-right: 1px solid var(--c-border); }
.catalog-header { flex-shrink: 0; padding: 20px 16px 16px; }
.catalog-header h2 { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin: 0 0 16px; font-size: 15px; line-height: 20px; font-weight: 600; }
.catalog-count, .tab-count { color: var(--c-text-muted); font-size: 12px; font-weight: 400; }
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
.agent-detail { flex: 1; min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
.agent-heading { padding: 24px 28px 20px; }
.agent-heading h2 { margin: 0; font-size: clamp(19px, 2vw, 26px); line-height: 1.4; font-weight: 500; letter-spacing: -.025em; overflow-wrap: anywhere; }
.agent-heading h2:focus { outline: none; }
.agent-heading p { max-width: 72ch; margin: 12px 0 0; font-size: 14px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.agent-back.text-action { display: none; margin-bottom: 20px; }
.agent-tabs { position: sticky; top: 0; z-index: 1; display: flex; gap: 20px; margin: 0 28px; border-bottom: 1px solid var(--c-border); background: var(--c-bg-card); }
.agent-tabs > button { display: flex; align-items: center; gap: 8px; min-height: 40px; padding: 8px 0; border: 0; border-bottom: 2px solid transparent; background: transparent; color: var(--c-text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.agent-tabs > button[aria-selected="true"] { border-bottom-color: var(--c-blue); color: var(--c-text); }
.agent-content { min-width: 0; padding: 24px 28px 32px; }
.overview-section { max-width: 72ch; }
.overview-section + .overview-section { margin-top: 32px; }
.overview-section h3 { margin: 0 0 16px; font-size: 14px; line-height: 20px; font-weight: 600; }
.agent-facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 20px 24px; margin: 0; }
.agent-facts dt, .tool-policies dt { margin-bottom: 6px; font-size: 12px; line-height: 20px; color: var(--c-text-muted); }
.agent-facts dd, .tool-policies dd { margin: 0; font-size: 13px; line-height: 1.6; overflow-wrap: anywhere; }
code { font: 12px/1.6 'IBM Plex Mono', ui-monospace, monospace; }
.tool-policies { display: grid; gap: 16px; margin: 0 0 16px; }
.tool-policies dd { display: flex; flex-wrap: wrap; gap: 4px 16px; }
.agent-note, .preview-scope, .prompt-estimate { margin: 12px 0; font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.agent-list .agent-note, .agent-list .agent-error { margin-inline: 8px; }
.preview-links > div { display: flex; flex-wrap: wrap; gap: 16px 24px; margin-top: 16px; }
.text-action { display: inline-flex; align-items: center; gap: 8px; min-height: 32px; padding: 0; border: 0; background: transparent; color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; text-decoration: underline; text-underline-offset: 4px; }
.text-action > span, .preview-copy > span { width: 14px; height: 14px; flex-shrink: 0; }
.preview-toolbar { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 16px; margin-bottom: 24px; }
.preview-channel { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; font-size: 12px; color: var(--c-text-secondary); }
.preview-channel select { min-width: 110px; min-height: 32px; padding: 4px 8px; border: 1px solid var(--c-control-border); background: var(--c-bg-input); color: var(--c-text); font: inherit; font-size: 13px; }
.preview-copy, .prompt-format button { display: inline-flex; align-items: center; justify-content: center; gap: 8px; min-height: 32px; padding: 6px 10px; border: 1px solid var(--c-border); background: transparent; color: var(--c-text); font: inherit; font-size: 13px; cursor: pointer; }
.preview-copy { margin-inline-start: auto; }
.preview-copy:disabled { opacity: .5; cursor: default; }
.prompt-format { display: flex; }
.prompt-format button + button { border-inline-start: 0; }
.prompt-format button[aria-pressed="true"] { background: var(--c-bg-muted); }
.tool-search { max-width: 360px; margin-bottom: 24px; }
.previous-context { padding: 12px; background: var(--c-bg-soft); font-size: 12px; line-height: 1.6; color: var(--c-text-secondary); overflow-wrap: anywhere; }
.agent-error { font-size: 13px; line-height: 1.6; color: var(--c-error); overflow-wrap: anywhere; }
.agent-error p { margin: 8px 0; }
.copy-feedback { font-size: 12px; color: var(--c-success); }
.preview-scope { margin-top: 32px; padding-top: 16px; border-top: 1px solid var(--c-border-soft); }
.agent-empty { margin: 24px 28px; color: var(--c-text-secondary); font-size: 13px; line-height: 1.6; }
button:focus-visible, select:focus-visible, [role="tabpanel"]:focus-visible { outline: 2px solid var(--c-blue); outline-offset: 2px; }
.agent-item:focus-visible { outline-offset: -2px; }
@container agent-browser (max-width: 700px) {
  .agent-navigation { flex-basis: 100%; border-right: 0; }
  .agent-browser-layout:not(.show-detail) .agent-detail, .agent-browser-layout.show-detail .agent-navigation { display: none; }
  .agent-back.text-action { display: inline-flex; }
  .agent-heading { padding: 20px 16px; }
  .agent-tabs { gap: 16px; margin-inline: 16px; }
  .agent-content { padding: 20px 16px 28px; }
  .agent-facts { grid-template-columns: minmax(0, 1fr); gap: 16px; }
  .preview-channel { flex-basis: 100%; justify-content: space-between; }
  .agent-tabs > button, .text-action, .preview-copy, .prompt-format button, .preview-channel select { min-height: 44px; }
  .agent-search input { min-height: 44px; font-size: 16px; }
}
@media (pointer: coarse) {
  .agent-tabs > button, .text-action, .preview-copy, .prompt-format button, .preview-channel select { min-height: 44px; }
  .agent-search input { min-height: 44px; font-size: 16px; }
}
</style>
