import { onActivated, onDeactivated, onUnmounted, ref, watch } from 'vue'
import { t } from './i18n.ts'
import { apiUrl } from './api-url.ts'
import { isRecord } from './folders-sidebar.ts'

export interface PublishedGroupSkill { name: string; tools: Array<{ name: string; modules: string[] }> }
export interface AgentGroupSetup {
  botInstanceId: string; agent: string; status: 'ready' | 'incomplete'; problem?: string
  source?: { kind: 'published_agent_profile'; revision: string }
  summary?: { hostModules?: string[]; tools: Array<{ name: string; description: string }>; reads: string[]; readFolders: string[]; restrictedSenders: number; targets: Array<{ kind: 'http' | 'inbox'; target: string; operations: string[]; authenticated: boolean }> }
}
function validSetup(value: unknown): value is AgentGroupSetup {
  if (!isRecord(value) || typeof value.botInstanceId !== 'string' || typeof value.agent !== 'string' || !['ready', 'incomplete'].includes(String(value.status)) || (value.problem !== undefined && typeof value.problem !== 'string')) return false
  if (value.source !== undefined && (!isRecord(value.source) || value.source.kind !== 'published_agent_profile' || typeof value.source.revision !== 'string')) return false
  if (value.status === 'ready' && (!value.source || !value.summary)) return false
  if (value.summary === undefined) return true
  const s = value.summary
  const strings = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
  return isRecord(s) && (s.hostModules === undefined || strings(s.hostModules)) && Array.isArray(s.tools) && s.tools.every(tool => isRecord(tool) && typeof tool.name === 'string' && typeof tool.description === 'string') && strings(s.reads) && strings(s.readFolders) && typeof s.restrictedSenders === 'number' && Array.isArray(s.targets) && s.targets.every(target => isRecord(target) && ['http', 'inbox'].includes(String(target.kind)) && typeof target.target === 'string' && strings(target.operations) && typeof target.authenticated === 'boolean')
}
export interface ServiceGroup {
  sessionId?: string; botInstanceId: string; platform: string; conversationId: string; name?: string; botName: string
  enabled: boolean; agent?: string; pending: boolean; lastSeen: number
  messages: Array<{ id: string; sender: string; text: string; state: 'received' | 'not_enabled' | 'not_triggered'; receivedAt: number }>
}
export function serviceGroupKey(group: Pick<ServiceGroup, 'botInstanceId' | 'conversationId'>): string {
  return JSON.stringify([group.botInstanceId, group.conversationId])
}
export function useServiceGroups(source: () => { apiBase: string; projectId: string; active: boolean; group?: string; session?: string }) {
  const lifecycleActive = ref(true)
  const agentSetups = ref<AgentGroupSetup[]>([])
  const skills = ref<PublishedGroupSkill[]>([]), agentRequirements = ref<Record<string, string[]>>({})
  const groups = ref<ServiceGroup[]>([]), agents = ref<string[]>([]), revision = ref(''), error = ref('')
  let controller: AbortController | undefined, timer: ReturnType<typeof setInterval> | undefined, generation = 0
  async function refresh() {
    if (!source().active || !lifecycleActive.value || controller) return
    const current = generation, request = controller = new AbortController()
    try {
      const url = apiUrl(source().apiBase, '/api/service-groups')
      if (source().group) url.searchParams.set('group', source().group!)
      if (source().session) url.searchParams.set('session', source().session!)
      const response = await fetch(url, { cache: 'no-store', redirect: 'error', signal: AbortSignal.any([request.signal, AbortSignal.timeout(10000)]) })
      if (!response.ok) throw new Error('Unavailable')
      const body: unknown = await response.json()
      if (!isRecord(body) || typeof body.revision !== 'string' || !Array.isArray(body.agents) || body.agents.some(agent => typeof agent !== 'string') || !Array.isArray(body.groups) || body.groups.length > 200) throw new Error('Invalid groups')
      for (const group of body.groups) {
        if (!isRecord(group) || (group.sessionId !== undefined && typeof group.sessionId !== 'string') || typeof group.botInstanceId !== 'string' || typeof group.conversationId !== 'string' || !['qq', 'feishu'].includes(String(group.platform)) || (group.name !== undefined && typeof group.name !== 'string') || (group.agent !== undefined && typeof group.agent !== 'string') || typeof group.botName !== 'string' || typeof group.enabled !== 'boolean' || typeof group.pending !== 'boolean' || typeof group.lastSeen !== 'number' || !Array.isArray(group.messages) || group.messages.length > 20) throw new Error('Invalid group')
        for (const message of group.messages) if (!isRecord(message) || typeof message.id !== 'string' || typeof message.sender !== 'string' || typeof message.text !== 'string' || message.text.length > 2000 || !['received', 'not_enabled', 'not_triggered'].includes(String(message.state)) || typeof message.receivedAt !== 'number') throw new Error('Invalid message')
      }
      if (current !== generation || request.signal.aborted) return
      skills.value = Array.isArray(body.skills) ? body.skills.filter((skill: unknown): skill is PublishedGroupSkill => isRecord(skill) && typeof skill.name === 'string' && Array.isArray(skill.tools) && skill.tools.every((tool: unknown) => isRecord(tool) && typeof tool.name === 'string' && Array.isArray(tool.modules) && tool.modules.every((name: unknown) => typeof name === 'string'))) : []; agentRequirements.value = isRecord(body.agentRequirements) ? Object.fromEntries(Object.entries(body.agentRequirements).filter(([, value]) => Array.isArray(value) && value.every(name => typeof name === 'string'))) as Record<string, string[]> : {};
      agentSetups.value = Array.isArray(body.agentSetups) ? body.agentSetups.filter(validSetup) : []
      groups.value = body.groups as unknown as ServiceGroup[]; agents.value = body.agents as string[]; revision.value = body.revision; error.value = ''
    } catch { if (current === generation && !request.signal.aborted) error.value = 'unavailable' }
    finally { if (controller === request) controller = undefined }
  }
  function stop() { generation++; controller?.abort(); controller = undefined; if (timer) clearInterval(timer); timer = undefined; agentSetups.value = []; skills.value = []; agentRequirements.value = {}; groups.value = []; agents.value = []; revision.value = ''; error.value = '' }
  watch(() => [source().apiBase, source().projectId, source().active, source().group, source().session, lifecycleActive.value], () => { stop(); if (source().active && lifecycleActive.value) { void refresh(); timer = setInterval(() => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') void refresh() }, 3000) } }, { immediate: true })
  onActivated(() => { lifecycleActive.value = true })
  onDeactivated(() => { lifecycleActive.value = false })
  onUnmounted(stop)
  return { groups, agents, agentSetups, skills, agentRequirements, revision, error, refresh }
}

// Display-only addresses are never passed to session prepare/send APIs.
export const OBSERVED_GROUP_PREFIX = 'observed-group:'
export function observedGroupId(group: Pick<ServiceGroup, 'botInstanceId' | 'conversationId'>) { return OBSERVED_GROUP_PREFIX + serviceGroupKey(group) }
export function observedGroupKey(id: string) { return id.startsWith(OBSERVED_GROUP_PREFIX) ? id.slice(OBSERVED_GROUP_PREFIX.length) : undefined }
export function groupDisplayName(group: Pick<ServiceGroup, 'name' | 'platform' | 'conversationId'>) {
  return group.name?.trim() || t('{platform} group · {suffix}', { platform: group.platform === 'qq' ? 'QQ' : 'Feishu', suffix: group.conversationId.slice(-6) })
}
export function projectGroupConversations(sessions: import('./folders-sidebar.ts').SidebarSession[], groups: ServiceGroup[], projectId: string): import('./folders-sidebar.ts').SidebarSession[] {
  const result = sessions.filter(s => (!s.projectId || s.projectId === projectId) && (!s.channelAddress || s.channelAddress.projectId === projectId)).map(s => ({ ...s }))
  const seen = new Set<string>()
  for (const group of groups) {
    const key = serviceGroupKey(group)
    if (seen.has(key)) continue
    seen.add(key)
    const existing = result.find(s => group.sessionId === s.sessionId || s.channelAddress?.projectId === projectId && s.channelAddress.botInstanceId === group.botInstanceId && s.channelAddress.platform === group.platform && s.channelAddress.conversationId === group.conversationId)
    if (existing) { existing.groupObservation = group; existing.channelAddress = { projectId, botInstanceId: group.botInstanceId, platform: group.platform, conversationId: group.conversationId };  existing.label = group.name?.trim() || (existing.title?.trim() ? existing.label : groupDisplayName(group)); continue }
    result.push({ sessionId: observedGroupId(group), projectId, channelAddress: { projectId, botInstanceId: group.botInstanceId, platform: group.platform, conversationId: group.conversationId }, label: groupDisplayName(group), isDirectChat: false, isCurrent: false, parentSessionId: null, depth: 0, groupObservation: group })
  }
  return result
}
