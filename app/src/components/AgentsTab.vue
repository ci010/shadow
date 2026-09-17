<template>
  <div class="grid gap-3 lg:grid-cols-[0.4fr_1.6fr] min-w-0">
    <!-- Sidebar: agent type list -->
    <div
      class="rounded-md border border-default bg-surface p-4 lg:sticky lg:top-10 lg:h-[calc(100vh-5rem)]">
      <h2 class="text-lg font-600">Agent Types</h2>
      <p class="mt-2 text-sm text-ink/60">Fully rendered system prompts and resolved tools.</p>

      <!-- Channel selector -->
      <div class="mt-3">
        <label class="text-xs text-ink/50 font-600">Simulate channel</label>
        <select v-model="channel" class="mt-1 w-full rounded border border-default bg-surface px-2 py-1 text-sm font-mono">
          <option v-for="ch in channels" :key="ch" :value="ch">{{ ch }}</option>
        </select>
      </div>

      <div class="mt-4 agent-list">
        <div v-if="listError" role="alert" class="text-sm text-ink/60">
          {{ listError }}
          <button type="button" class="underline" @click="loadAgentTypes">Retry</button>
        </div>
        <div v-else-if="loadingList" class="text-sm text-ink/40">Loading…</div>
        <div v-else-if="agentTypes.length === 0" class="text-sm text-ink/40">No agent types available.</div>
        <button
          v-for="a in agentTypes" :key="a.name"
          type="button"
          class="agent-item"
          :class="{ active: requestedAgent?.name === a.name }"
          :aria-pressed="requestedAgent?.name === a.name"
          @click="selectAgent(a)"
        >
          <div class="agent-item-top">
            <span class="agent-name">{{ a.name }}</span>
            <span v-if="a.defaultMode" class="badge badge-mode">{{ a.defaultMode }}</span>
          </div>
          <span class="agent-desc">{{ a.description }}</span>
          <span class="agent-source" :class="a.source">{{ a.source }}</span>
        </button>
      </div>
    </div>

    <!-- Main: agent type detail -->
    <div class="flex flex-col gap-3 min-w-0" :aria-busy="loadingContext">
      <p v-if="loadingContext" role="status" class="text-sm text-ink/60">
        Loading {{ requestedAgent?.name }} context ({{ channel }})…
      </p>
      <div v-if="contextError" role="alert" class="text-sm text-ink/60">
        {{ contextError }}
        <span v-if="selected">Showing the previous context.</span>
        <button type="button" class="underline" @click="retryContext">Retry</button>
      </div>
      <template v-if="selected">
      <!-- Config card -->
      <div class="rounded-md border border-default bg-surface p-4">
        <h2 class="text-lg font-600">{{ selected.name }}</h2>
        <p class="mt-1 text-sm text-ink/60">{{ selected.description }}</p>

        <div class="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
          <div><span class="text-ink/50">Source:</span> <span class="font-mono">{{ selected.source }}</span></div>
          <div><span class="text-ink/50">Default mode:</span> {{ selected.defaultMode ?? 'session' }}</div>
          <div><span class="text-ink/50">Can Spawn:</span> {{ selected.canSpawn ? 'Yes' : 'No' }}</div>
          <div v-if="selected.model"><span class="text-ink/50">Model:</span> <span class="font-mono">{{ selected.model }}</span></div>
          <div v-if="selected.temperature != null"><span class="text-ink/50">Temperature:</span> {{ selected.temperature }}</div>
          <div v-if="selected.maxTokens != null"><span class="text-ink/50">Max Tokens:</span> {{ selected.maxTokens }}</div>
        </div>

        <!-- Include flags -->
        <div class="mt-4">
          <h3 class="text-sm font-600 text-ink/70 mb-2">Prompt Includes</h3>
          <div class="flex flex-wrap gap-2">
            <span v-for="flag in includeFlags" :key="flag.key"
              class="badge" :class="flag.value ? 'badge-on' : 'badge-off'">
              {{ flag.label }}
            </span>
          </div>
        </div>

        <!-- Tool policies (from definition) -->
        <div v-if="selected.allowedTools?.length" class="mt-4">
          <h3 class="text-sm font-600 text-ink/70 mb-2">Allowed Tools (whitelist)</h3>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="t in selected.allowedTools" :key="t" class="badge badge-tool">{{ t }}</span>
          </div>
        </div>
        <div v-if="selected.blockedTools?.length" class="mt-4">
          <h3 class="text-sm font-600 text-ink/70 mb-2">Blocked Tools</h3>
          <div class="flex flex-wrap gap-1.5">
            <span v-for="t in selected.blockedTools" :key="t" class="badge badge-blocked">{{ t }}</span>
          </div>
        </div>
      </div>

      <!-- Resolved tools -->
      <ToolsCard
        :tools="resolvedTools"
        :empty-message="loadingContext ? 'Loading…' : 'No tools available.'"
      />

      <!-- Rendered system prompt -->
      <SystemPromptCard
        :prompt="renderedSystemPrompt"
        :empty-message="loadingContext ? 'Loading…' : 'No system prompt.'"
        show-token-estimate
      />
      </template>

      <div v-else-if="!loadingContext && !contextError" class="rounded-md border border-default bg-surface p-4 flex items-center justify-center text-ink/40">
        Select an agent type to inspect
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { apiUrl } from '../api-url.ts'
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import SystemPromptCard from './SystemPromptCard.vue'
import ToolsCard from './ToolsCard.vue'
import type { ToolDef } from './ToolsCard.vue'

interface AgentTypeMeta {
  name: string
  description: string
  source: 'builtin' | 'workspace'
  allowedTools?: string[]
  blockedTools?: string[]
  canSpawn: boolean
  defaultMode?: 'session' | 'task' | 'call'
  includeWorkspaceIntro: boolean
  includeMemory: boolean
  includeSafety: boolean
  includeBackground: boolean
  includeIdentityLookup: boolean
  model?: string
  temperature?: number
  maxTokens?: number
}

const props = defineProps<{ apiBase: string }>()

const route = useRoute()
const router = useRouter()

function buildUrl(path: string, params?: Record<string, string>): string {
  return apiUrl(props.apiBase, path, params).toString()
}

const channels = ['heartbeat', 'web', 'discord', 'wechat', 'feishu']
const channel = computed({
  get: () => typeof route.query.channel === 'string' && channels.includes(route.query.channel)
    ? route.query.channel : 'heartbeat',
  set: value => {
    void router.replace({ query: { ...route.query, channel: value } })
  },
})
const agentTypes = ref<AgentTypeMeta[]>([])
const requestedAgent = computed(() => agentTypes.value.find(a => a.name === route.params.agentName) ?? agentTypes.value[0])
const selected = ref<AgentTypeMeta | null>(null)
const renderedSystemPrompt = ref('')
const resolvedTools = ref<ToolDef[]>([])
const loadingContext = ref(false)
const loadingList = ref(true)
const listError = ref('')
const contextError = ref('')
let listRequest: AbortController | undefined
let contextRequest: AbortController | undefined

const includeFlags = computed(() => {
  if (!selected.value) return []
  const s = selected.value
  return [
    { key: 'workspaceIntro', label: 'Workspace Intro', value: s.includeWorkspaceIntro },
    { key: 'memory', label: 'Memory', value: s.includeMemory },
    { key: 'safety', label: 'Safety', value: s.includeSafety },
    { key: 'background', label: 'Background', value: s.includeBackground },
    { key: 'identityLookup', label: 'Identity Lookup', value: s.includeIdentityLookup },
  ]
})

async function loadAgentTypes() {
  listRequest?.abort()
  const request = new AbortController()
  listRequest = request
  loadingList.value = true
  listError.value = ''
  try {
    const res = await fetch(buildUrl('/debug/agent-types'), { signal: request.signal })
    if (!res.ok) throw new Error(`Failed to load agent types (${res.status}).`)
    const data: AgentTypeMeta[] = await res.json()
    if (request.signal.aborted) return
    agentTypes.value = data
    if (requestedAgent.value && route.params.agentName !== requestedAgent.value.name) {
      selectAgent(requestedAgent.value)
    }
  } catch (e) {
    if (request.signal.aborted) return
    listError.value = e instanceof Error ? e.message : 'Failed to load agent types.'
    console.error('Failed to load agent types:', e)
  } finally {
    if (!request.signal.aborted) loadingList.value = false
  }
}

async function loadContext(agent: AgentTypeMeta) {
  contextRequest?.abort()
  const request = new AbortController()
  contextRequest = request
  loadingContext.value = true
  contextError.value = ''
  try {
    const res = await fetch(buildUrl(`/debug/agent-types/${encodeURIComponent(agent.name)}/context`, { channel: channel.value }), { signal: request.signal })
    if (!res.ok) throw new Error(`Failed to load ${agent.name} context (${res.status}).`)
    const data = await res.json()
    if (request.signal.aborted) return
    selected.value = agent
    renderedSystemPrompt.value = data.systemPrompt ?? ''
    resolvedTools.value = data.tools ?? []
  } catch (e) {
    if (request.signal.aborted) return
    contextError.value = e instanceof Error ? e.message : `Failed to load ${agent.name} context.`
    console.error('Failed to load agent context:', e)
  } finally {
    if (!request.signal.aborted) loadingContext.value = false
  }
}

function selectAgent(a: AgentTypeMeta) {
  void router.replace({
    name: 'agents',
    params: { ...route.params, agentName: a.name },
    query: { ...route.query, channel: channel.value },
  })
}

function retryContext() {
  if (requestedAgent.value) void loadContext(requestedAgent.value)
}

watch([requestedAgent, channel], () => { retryContext() })
onMounted(loadAgentTypes)
onUnmounted(() => {
  listRequest?.abort()
  contextRequest?.abort()
})
</script>

<style scoped>
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  overflow-y: auto;
  max-height: calc(100vh - 20rem);
}

.agent-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  padding: 0.5rem 0.6rem;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  text-align: left;
  cursor: pointer;
  background: var(--c-bg-soft);
  transition: background 0.1s, border-color 0.1s, transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.agent-item:hover {
  background: var(--c-bg-muted);
  border-color: var(--c-border-soft);
  transform: translateX(2px);
}

.agent-item.active {
  background: var(--c-primary-bg);
  border-color: var(--c-primary-bg);
  color: var(--c-text-on-primary);
}

.agent-item-top {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.3rem;
}

.agent-name {
  font-family: 'IBM Plex Mono', ui-monospace, monospace;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.01em;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.agent-desc {
  font-size: 0.6rem;
  color: var(--c-text-muted);
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.3;
}

.agent-item.active .agent-desc {
  color: rgba(255, 255, 255, 0.65);
}

.agent-source {
  font-size: 0.5rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--c-text-muted);
}

.agent-source.builtin {
  color: var(--c-blue);
}

.agent-source.workspace {
  color: var(--c-amber);
}

.agent-item.active .agent-source {
  color: var(--c-badge-active-overlay);
}

.badge {
  display: inline-block;
  padding: 0.05rem 0.35rem;
  border-radius: var(--radius-sm);
  font-size: 0.6rem;
  font-weight: 600;
}
.badge-builtin { background: var(--c-info-bg); color: var(--c-info); }
.badge-workspace { background: var(--c-warn-bg); color: var(--c-warn); }
.badge-mode { background: var(--c-purple-bg); color: var(--c-purple); }
.agent-item.active .badge-mode { background: var(--c-purple-bg); color: var(--c-purple-border); }
.badge-on { background: var(--c-success-bg); color: var(--c-success); }
.badge-off { background: var(--c-bg-muted); color: var(--c-text-muted); }
.badge-tool { background: var(--c-info-bg); color: var(--c-info); font-family: 'IBM Plex Mono', ui-monospace, monospace; }
.badge-blocked { background: var(--c-error-bg); color: var(--c-error); font-family: 'IBM Plex Mono', ui-monospace, monospace; }
</style>
