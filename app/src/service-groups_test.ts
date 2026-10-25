import test from 'node:test'
import assert from 'node:assert/strict'
import { projectGroupConversations, observedGroupId, observedGroupKey, groupDisplayName, type ServiceGroup } from './service-groups.ts'
import type { SidebarSession } from './folders-sidebar.ts'
const group: ServiceGroup = { botInstanceId: 'qq-service', platform: 'qq', conversationId: 'group:00112233445566778899', botName: 'QQ', enabled: false, pending: true, lastSeen: 1, messages: [] }
const session: SidebarSession = { sessionId: 'historical-id', projectId: 'p', channelAddress: { projectId: 'p', botInstanceId: group.botInstanceId, platform: 'qq', conversationId: group.conversationId }, label: 'old', isDirectChat: false, isCurrent: false, parentSessionId: null, depth: 0 }
test('observed groups project into the existing Bot conversation tree without creating executable sessions', () => {
 const rows = projectGroupConversations([], [group, group], 'p')
 assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, observedGroupId(group)); assert.equal(observedGroupKey(rows[0].sessionId), JSON.stringify([group.botInstanceId, group.conversationId]))
 assert.equal(rows[0].isDirectChat, false); assert.equal(rows[0].groupObservation?.pending, true)
 assert.equal(groupDisplayName(group), 'QQ group · 778899'); assert(!rows[0].label.includes('group:'))
})
test('existing QQ history keeps its exact ID and is deduplicated by full scoped Bot address', () => {
 const rows = projectGroupConversations([session], [group], 'p')
 assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, 'historical-id'); assert.equal(session.label, 'old')
 assert.equal(rows[0].groupObservation, group)
})
test('canonical legacy IDs match without creating a parallel row', () => {
 const legacy = { ...session, sessionId: 'qq:group:old', channelAddress: undefined }
 const rows = projectGroupConversations([legacy], [{ ...group, sessionId: legacy.sessionId }], 'p')
 assert.equal(rows.length, 1); assert.equal(rows[0].sessionId, legacy.sessionId); assert.equal(rows[0].channelAddress?.botInstanceId, group.botInstanceId)
})
test('cross Project and cross Bot addresses cannot steal existing sessions', () => {
 assert.equal(projectGroupConversations([{ ...session, projectId: 'other' }], [group], 'p')[0].sessionId, observedGroupId(group))
 const other = { ...session, channelAddress: { ...session.channelAddress!, projectId: 'other' } }
 assert.equal(projectGroupConversations([other], [group], 'p').length, 1)
 assert.equal(projectGroupConversations([session], [{ ...group, botInstanceId: 'another' }], 'p').length, 2)
})
