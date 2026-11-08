import assert from 'node:assert/strict'
import test from 'node:test'
import { groupFolderSessions, parseSessionGraph } from './folders-sidebar.ts'
import { groupBotConversations } from './bot-sidebar.ts'

const inbox = (project: string, bot: string, platform: string, conversation: string) =>
  'channel-inbox:' + [project, bot, platform, conversation].map(encodeURIComponent).join(':')

test('passive inboxes nest under exact Project Bot roots, alongside active history', () => {
  const discord = inbox('xmcl', 'discord-support', 'discord', 'room:one')
  const qq = inbox('xmcl', 'qq-support', 'qq', 'group:one')
  const sessions = parseSessionGraph({ nodes: [], sessions: [
    { sessionId: discord, projectId: 'xmcl', title: 'Welcome' },
    { sessionId: qq, projectId: 'xmcl', title: 'QQ group' },
    { sessionId: 'bot:xmcl:discord-support:discord:history', projectId: 'xmcl' },
    { sessionId: 'web:chat', projectId: 'xmcl' },
  ] }, 'xmcl')
  const groups = groupBotConversations(sessions, 'xmcl', [
    { id: 'discord-support', projectId: 'other', platform: 'discord', displayName: 'Foreign' },
    { id: 'discord-support', projectId: 'xmcl', platform: 'discord', displayName: 'XMCL Support' },
    { id: 'qq-support', projectId: 'xmcl', platform: 'qq', displayName: 'XMCL QQ' },
  ])
  assert.deepEqual(groups.chats.map(s => s.sessionId), ['web:chat'])
  assert.deepEqual(groups.bots.map(g => [g.label, g.sessions.length]), [['XMCL Support', 2], ['XMCL QQ', 1]])
  assert.equal(groups.bots[0]!.sessions[0]!.sessionId, discord)
  assert.equal(groups.bots[0]!.sessions[0]!.channelAddress?.conversationId, 'room:one')
})

test('passive sidebar addresses reject foreign Projects and malformed tuples', () => {
  for (const sessionId of [inbox('other', 'bot', 'discord', 'room'), 'channel-inbox:xmcl:bad%:discord:room', 'channel-inbox:xmcl:bot:discord']) {
    assert.throws(() => parseSessionGraph({ nodes: [], sessions: [{ sessionId, projectId: 'xmcl' }] }, 'xmcl'))
  }
})

test('Bot trees do not consume or inherit the ten ordinary conversation slots', () => {
  const sessions = parseSessionGraph({ nodes: [], sessions: [
    ...Array.from({ length: 15 }, (_, i) => ({ sessionId: `web:chat-${i}`, projectId: 'xmcl', lastActivityAt: new Date(1000 + i).toISOString() })),
    ...Array.from({ length: 12 }, (_, i) => ({ sessionId: inbox('xmcl', 'discord', 'discord', `room-${i}`), projectId: 'xmcl', lastActivityAt: new Date(10000 + i).toISOString() })),
    { sessionId: 'bot:xmcl:qq:qq:group%3Aone', projectId: 'xmcl', folderId: 'code' },
    { sessionId: 'observed-group:qq:two', projectId: 'xmcl' },
  ] }, 'xmcl')
  // Discovery rows also carry an explicit scoped address before folder grouping.
  sessions.at(-1)!.channelAddress = { projectId: 'xmcl', botInstanceId: 'qq', platform: 'qq', conversationId: 'group:two' }
  const folder = { id: 'code', name: 'Code', path: '/synthetic/code', createdAt: '' }
  for (const activeSessionId of ['web:chat-0', sessions[15]!.sessionId, '']) {
    const folders = groupFolderSessions([folder], sessions, { activeSessionId })
    const groups = groupBotConversations(folders.unified, 'xmcl')
    assert.equal(groups.chats.length, 10)
    assert.equal(groups.bots.reduce((sum, group) => sum + group.sessions.length, 0), 14)
    assert.equal(groups.bots[0]!.sessions.length, 12, 'Bot conversations are not capped at ten')
    assert.equal(folders.folders[0]!.sessions.length, 1, 'Folder ownership is retained')
    assert.equal(groupBotConversations(folders.chats, 'xmcl').bots.reduce((sum, group) => sum + group.sessions.length, 0), 13)
    if (activeSessionId === 'web:chat-0') assert.ok(groups.chats.some(s => s.sessionId === activeSessionId))
    else assert.deepEqual(new Set(groups.chats.map(s => s.sessionId)), new Set(Array.from({ length: 10 }, (_, i) => `web:chat-${i + 5}`)))
  }
  assert.equal(groupFolderSessions([], sessions).unified.length, sessions.length, 'Uncapped callers retain the full source')
})
