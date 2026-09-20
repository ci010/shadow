import assert from 'node:assert/strict'
import test from 'node:test'
import { channelSessionId } from '../../src/bus/events.ts'
import { groupFolderSessions, parseSessionGraph } from './folders-sidebar.ts'
import { botConnectionIndicator, botSidebarStorageKey, groupBotConversations, restoreCollapsedBots, saveCollapsedBots, type SidebarBot } from './bot-sidebar.ts'

const id = (botInstanceId: string, conversationId: string, projectId = 'a', platform = 'qq') =>
  channelSessionId({ projectId, botInstanceId, platform, conversationId })
const bots: SidebarBot[] = [
  { id: 'qq-one', projectId: 'a', platform: 'qq', displayName: 'Support bot' },
  { id: 'qq-two', projectId: 'a', platform: 'qq', displayName: 'Personal bot' },
  { id: 'qq-one', projectId: 'b', platform: 'qq', displayName: 'Foreign bot name' },
]

test('bot sections use exact decoded instance identity and retain conversation order, labels and activity data', () => {
  const sessions = parseSessionGraph({ nodes: [], sessions: [
    { sessionId: id('qq-two', 'dm:person'), title: 'Personal message' },
    { sessionId: id('qq-one', 'group:room'), title: 'Support room', current: 'physical', waitingForCall: true },
    { sessionId: 'web:chat-free', title: 'Free chat' },
    { sessionId: id('qq-one', 'dm:person'), title: 'Support DM' },
    { sessionId: id('qq-two', 'group:room'), title: 'Personal room' },
    { sessionId: id('qq-one:separate', 'dm:person') },
    { sessionId: 'qq:dm:legacy', title: 'Legacy chat' },
  ] }, 'a')
  const before = structuredClone(sessions)
  const groups = groupBotConversations(sessions, 'a', bots)
  assert.deepEqual(groups.bots.map(group => [group.id, group.label]), [
    ['qq-two', 'Personal bot'], ['qq-one', 'Support bot'], ['qq-one:separate', 'QQ · qq-one:separate'],
  ])
  assert.deepEqual(groups.bots[1]!.sessions.map(session => session.label), ['Support room', 'Support DM'])
  assert.equal(groups.bots[1]!.sessions[0], sessions[1], 'Grouping preserves the existing row data and selection identity')
  assert.equal(groups.bots[1]!.sessions[0]!.waitingForCall, true)
  assert.deepEqual(groups.chats.map(session => session.label), ['Free chat', 'Legacy chat'])
  assert.equal(groups.bots[2]!.sessions[0]!.label, 'dm:person', 'Untitled bot chats do not display an encoded session ID')
  assert.deepEqual(sessions, before)
})

test('foreign Project sessions and bot names never appear in an owning Project section', () => {
  const sessions = parseSessionGraph({ nodes: [], sessions: [
    { sessionId: id('qq-one', 'dm:own'), projectId: 'a' },
    { sessionId: id('qq-one', 'dm:foreign', 'b'), projectId: 'b', title: 'Foreign conversation' },
    { sessionId: 'web:foreign', projectId: 'b', title: 'Foreign web chat' },
  ] })
  const groups = groupBotConversations(sessions, 'a', [...bots].reverse())
  assert.equal(groups.bots.length, 1)
  assert.equal(groups.bots[0]!.label, 'Support bot')
  assert.deepEqual(groups.bots[0]!.sessions.map(session => session.sessionId), [id('qq-one', 'dm:own')])
  assert.deepEqual(groups.chats, [])
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ sessionId: id('qq-one', 'room', 'b') }] }, 'a'), /Cannot read/)
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ sessionId: id('qq-one', 'room'), projectId: 'b' }] }), /Cannot read/)
  assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ sessionId: 'bot:a:bad%:qq:room' }] }), /Cannot read/)
})

test('folder and automation ownership take precedence without duplicating bot conversations or adding empty bot sections', () => {
  const folder = { id: 'folder', name: 'Code', path: 'C:\\synthetic\\code', createdAt: '' }
  const sessions = parseSessionGraph({ nodes: [], sessions: [
    { sessionId: id('qq-one', 'group:folder'), folderId: folder.id },
    { sessionId: id('qq-two', 'dm:unregistered-folder'), folderId: 'missing' },
    { sessionId: 'web:normal', folderId: folder.id },
    { sessionId: id('qq-one', 'group:automation'), folderId: folder.id,
      automation: { jobId: 'scheduled', name: 'Scheduled task', runId: 'run', startedAt: '2026-09-18T00:00:00Z', contextMode: 'fresh' } },
  ] }, 'a')
  const folders = groupFolderSessions([folder], sessions)
  const groups = groupBotConversations(folders.chats, 'a', bots)
  assert.deepEqual(folders.folders[0]!.sessions.map(session => session.sessionId), [id('qq-one', 'group:folder'), 'web:normal'])
  assert.deepEqual(groups.bots.map(group => group.id), ['qq-two'])
  assert.deepEqual(folders.automations[0]!.sessions.map(session => session.sessionId), [id('qq-one', 'group:automation')])
  assert.deepEqual(groups.chats, [])
  assert.deepEqual(groupBotConversations([], 'a', bots), { chats: [], bots: [] })
  assert.equal(groupBotConversations(sessions, undefined, bots).chats.length, sessions.length, 'Unscoped legacy sidebars do not guess a Project')
})

test('bot disclosure preferences persist independently per server, Project and exact bot ID', () => {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  assert.deepEqual([...restoreCollapsedBots(storage, '/main', 'a')], [])
  saveCollapsedBots(storage, '/main', 'a', new Set(['qq-one', 'qq-one:separate']))
  assert.deepEqual([...restoreCollapsedBots(storage, '/main', 'a')], ['qq-one', 'qq-one:separate'])
  assert.deepEqual([...restoreCollapsedBots(storage, '/main', 'b')], [])
  assert.deepEqual([...restoreCollapsedBots(storage, '/other-main', 'a')], [])
  saveCollapsedBots(storage, '/main', 'a', new Set(['qq-one:separate']))
  assert.deepEqual([...restoreCollapsedBots(storage, '/main', 'a')], ['qq-one:separate'])
  data.set(botSidebarStorageKey('/main', 'a'), '{"collapsed":"bad"}')
  assert.throws(() => restoreCollapsedBots(storage, '/main', 'a'), /Invalid bot sidebar/)
})

test('connection indicators distinguish verified connectivity from running, offline and unavailable states', () => {
  for (const state of ['connected', 'connecting', 'disconnected', 'disabled', 'unconfigured', 'error', 'running', 'restart-required'] as const) {
    const indicator = botConnectionIndicator({ state, configured: state !== 'unconfigured' })
    assert.equal(indicator.state, state)
    assert.match(indicator.icon, /^i-lucide-/)
    assert.ok(indicator.label)
    if (state !== 'connected') assert.notEqual(indicator.icon, 'i-lucide-circle-check')
  }
  assert.match(botConnectionIndicator({ state: 'running', configured: true }).label, /unverified/)
  assert.equal(botConnectionIndicator().state, 'unknown')
  assert.match(botConnectionIndicator().label, /unavailable/)
  assert.equal(botConnectionIndicator({ state: 'disabled', configured: false }).label, 'Not configured')
})

test('connection status belongs to the exact Project and bot, never to its conversation activity', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: id('qq-one', 'dm:own'), waitingForCall: true },
    { sessionId: id('qq-two', 'group:own') },
  ], nodes: [] }, 'a')
  const catalog: SidebarBot[] = bots.map(bot => ({
    ...bot, connection: { state: bot.projectId === 'b' ? 'connected' : 'disconnected', configured: true },
  }))
  const groups = groupBotConversations(sessions, 'a', catalog.toReversed())
  assert.deepEqual(groups.bots.map(bot => bot.connection.state), ['disconnected', 'disconnected'])
  assert.equal(groupBotConversations(sessions, 'a').bots[0]!.connection.state, 'unknown')
})
