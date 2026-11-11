import test from 'node:test'
import assert from 'node:assert/strict'
import { discordChannelPosts, discordChannelHistories, discordChannelId, discordChannelKey, discordParentKey, isDisplayOnlyConversation, projectDiscordChannels } from './discord-navigation.ts'
import { groupBotConversations } from './bot-sidebar.ts'
import type { SidebarSession } from './folders-sidebar.ts'
function session(id: string, type = 11, parentId: string | null = '100', bot = 'one', guild = '200'): SidebarSession {
  return { sessionId: id, projectId: 'p', channelAddress: { projectId: 'p', platform: 'discord', botInstanceId: bot, conversationId: '300' }, discordChannel: { id: '300', name: 'Thread', type, guildId: guild, parentId, parentName: 'Forum' }, label: id, depth: 0, parentSessionId: null, isDirectChat: false, isCurrent: false }
}
test('known threads collapse at Bot boundary; original passive and old history IDs survive', () => {
  const histories = [session('passive'), session('old')]
  const rows = groupBotConversations(histories, 'p').bots[0].sessions
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'Forum')
  assert.deepEqual(rows[0].discordHistoryIds, ['passive', 'old'])
  assert.ok(isDisplayOnlyConversation(rows[0].sessionId))
  const key = discordChannelKey(rows[0].sessionId)!
  assert.deepEqual(discordChannelHistories(histories, key).map(s => s.sessionId), ['passive', 'old'])
  assert.equal(discordChannelId(key), rows[0].sessionId)
})
test('category parent is not thread ancestry and all three thread types use parent', () => {
  assert.equal(discordParentKey(session('text', 0))?.channelId, '300')
  for (const type of [10, 11, 12]) assert.equal(discordParentKey(session('thread', type))?.channelId, '100')
})
test('scope separates projects, bots and guilds, and never guesses unknown ancestry', () => {
  const unknown = session('unknown', 11, null)
  const mismatch = session('mismatch'); mismatch.discordChannel!.id = '999'
  const absent = session('absent'); delete absent.discordChannel
  const histories = [session('a'), session('b', 11, '100', 'two'), session('c', 11, '100', 'one', '201'), unknown, mismatch, absent]
  const rows = projectDiscordChannels(histories)
  assert.equal(rows.length, 6)
  assert.ok(rows.includes(unknown) && rows.includes(mismatch) && rows.includes(absent))
  assert.deepEqual(discordChannelHistories(histories, discordParentKey(histories[0])!).map(s => s.sessionId), ['a'])
  assert.equal(discordChannelKey('discord-channel:["p"]'), undefined)
})
test('parent title evidence is retained when later passive metadata omits the name', () => {
  const old = session('old'), passive = session('passive')
  passive.discordChannel!.parentName = null
  assert.equal(projectDiscordChannels([old, passive])[0].label, 'Forum')
  assert.equal(projectDiscordChannels([passive, old])[0].label, 'Forum')
  assert.equal(projectDiscordChannels([passive])[0], passive, 'A lone unnamed parent adds no extra navigation level')
})

test('single ordinary text channel opens directly, forums and parents with threads use an index', () => {
  const text = session('text', 0)
  assert.equal(projectDiscordChannels([text])[0], text)
  for (const type of [15, 16]) assert.ok(isDisplayOnlyConversation(projectDiscordChannels([session('forum', type)])[0].sessionId))
  const thread = session('thread'); thread.discordChannel!.parentId = '300'
  assert.equal(projectDiscordChannels([text, thread]).length, 1)
  assert.ok(isDisplayOnlyConversation(projectDiscordChannels([text, thread])[0].sessionId))
  assert.ok(isDisplayOnlyConversation(projectDiscordChannels([text, { ...text, sessionId: 'old-text' }])[0].sessionId))
})
test('post projection groups exact conversations but retains every original history ID', () => {
  const old = session('old'), passive = session('channel-inbox:passive')
  passive.lastActivityAt = '2026-11-01T12:00:00Z'
  const posts = discordChannelPosts([old, passive, session('foreign', 11, '100', 'other')], discordParentKey(old)!)
  assert.equal(posts.length, 1)
  assert.equal(posts[0].title, 'Thread')
  assert.equal(posts[0].lastActivityAt, passive.lastActivityAt)
  assert.deepEqual(posts[0].histories.map(s => s.sessionId), ['old', 'channel-inbox:passive'])
})

test('legacy passive category ancestry cannot create a redundant category index', () => {
  const oldChat = session('old-chat', 0, '400')
  oldChat.discordChannel!.name = 'Chat'
  const passiveChat = session('channel-inbox:chat', 11, '400')
  passiveChat.discordChannel!.parentName = null
  const theme = session('channel-inbox:theme', 11, '400')
  theme.channelAddress!.conversationId = theme.discordChannel!.id = '301'
  theme.discordChannel!.name = 'Theme'; theme.discordChannel!.parentName = null
  const original = structuredClone([oldChat, passiveChat, theme])
  const rows = projectDiscordChannels([oldChat, passiveChat, theme])
  assert.equal(rows.length, 2)
  assert.ok(rows.every(row => discordChannelKey(row.sessionId)?.channelId !== '400'))
  assert.deepEqual(rows[0].discordHistoryIds, ['old-chat', 'channel-inbox:chat'])
  assert.equal(rows[1].sessionId, theme.sessionId)
  assert.deepEqual(discordChannelHistories([oldChat, passiveChat, theme], discordChannelKey(rows[0].sessionId)!).map(s => s.sessionId), ['old-chat', 'channel-inbox:chat'])
  assert.deepEqual([oldChat, passiveChat, theme], original, 'Display normalization never rewrites persisted origin or history')
  const foreign = session('foreign', 11, '400', 'other')
  foreign.discordChannel!.parentName = 'Real foreign forum'
  assert.equal(projectDiscordChannels([oldChat, foreign]).at(-1)!.label, 'Real foreign forum')
})
