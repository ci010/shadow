import { computed, shallowRef, watch } from 'vue'
import { t } from './i18n.ts'
import { useLiveClientPool } from './composables/useLiveClient.ts'
import { useBotResourceStore } from './stores/bots.ts'
import { requireResourcePinia } from './stores/app.ts'
import { useCatalogVisibility } from './resources/catalog-visibility.ts'

import { type ServiceGroup, type ServiceGroupSource } from './service-group-contract.ts'
export { parseServiceGroups, type ServiceGroup, type ServiceGroupSource } from './service-group-contract.ts'
export function serviceGroupKey(group: Pick<ServiceGroup, 'botInstanceId' | 'conversationId'>): string {
  return JSON.stringify([group.botInstanceId, group.conversationId])
}

export function useServiceGroups(source: () => ServiceGroupSource) {
  const pool = useLiveClientPool()
  const owner = useBotResourceStore(requireResourcePinia()).owner
  const enabled = useCatalogVisibility(() => source().active)
  const current = shallowRef<ReturnType<typeof owner.groups>>()
  watch(() => [source().apiBase, source().projectId, source().group, source().session, enabled.value] as const,
    ([apiBase, projectId, group, session, active], _, cleanup) => {
      current.value = undefined
      if (!active) return
      const lease = owner.groups({ apiBase, projectId, group, session, active }, pool)
      current.value = lease
      cleanup(lease.release)
    }, { immediate: true })
  return {
    groups: computed(() => current.value?.state.value.value?.groups ?? []),
    agents: computed(() => current.value?.state.value.value?.agents ?? []),
    revision: computed(() => current.value?.state.value.value?.revision ?? ''),
    error: computed(() => current.value?.state.value.error ?? ''),
    refresh: () => current.value?.refresh() ?? Promise.resolve(),
  }
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
    if (existing) { existing.groupObservation = group; existing.channelAddress = { projectId, botInstanceId: group.botInstanceId, platform: group.platform, conversationId: group.conversationId };  if (!existing.channelSource) existing.label = group.name?.trim() || (existing.title?.trim() ? existing.label : groupDisplayName(group)); continue }
    result.push({ sessionId: observedGroupId(group), projectId, channelAddress: { projectId, botInstanceId: group.botInstanceId, platform: group.platform, conversationId: group.conversationId }, label: groupDisplayName(group), isDirectChat: false, isCurrent: false, parentSessionId: null, depth: 0, groupObservation: group })
  }
  return result
}
