import assert from 'node:assert/strict'
import test from 'node:test'
import { parseSessionGraph } from './folders-sidebar.ts'
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
