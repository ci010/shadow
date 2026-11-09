import assert from 'node:assert/strict'
import test from 'node:test'
import { discordChannelNavigation } from './discord-navigation.ts'

const uuid = '11111111-1111-4111-8111-111111111111'
const boundary = () => ({ version: 1, bindingId: uuid, revision: 'a'.repeat(64), agentId: uuid,
  agentVersion: 'b'.repeat(64), epoch: uuid, domainId: uuid, startSegment: 0,
  startedAt: '2026-11-08T00:00:00Z', botInstanceId: 'connection', botUserId: '100', conversationId: '200', sources: [],
  location: { id: '200', name: 'Post', type: 11, guildId: '300', guildName: 'Guild', parentId: '400', parentName: 'Forum', recipientId: null },
})
const origin = () => ({ version: 1, projectId: 'p', botInstanceId: 'connection', platform: 'discord', conversationId: '200',
  kind: 'thread', parentId: '400', guildId: '300', botUserId: '100', name: 'Post' })

test('old Bot history projects bounded verified Discord location only', () => {
  const state = { projectId: 'p', sessionId: 'bot:p:connection:discord:200', channelBoundary: boundary() }
  assert.deepEqual(discordChannelNavigation(state, 'p'), { id: '200', name: 'Post', type: 11, guildId: '300', parentId: '400', parentName: 'Forum' })
  for (const change of [{ projectId: 'other' }, { mode: 'task' }, { sessionId: 'bot:p:other:discord:200' },
    { channelBoundary: { ...boundary(), ownerSessionId: 'web:owner' } },
    { channelBoundary: { ...boundary(), conversationId: '201' } },
    { channelBoundary: { ...boundary(), location: { ...boundary().location, id: '201' } } }, { channelBoundary: {} }]) {
    assert.equal(discordChannelNavigation({ ...state, ...change }, 'p'), undefined)
  }
  assert.equal(discordChannelNavigation(state, 'foreign'), undefined)
})

test('passive inbox projects ancestry only when its entire scoped identity matches', () => {
  const state = { projectId: 'p', sessionId: 'channel-inbox:p:connection:discord:200', channelSource: origin() }
  assert.deepEqual(discordChannelNavigation(state, 'p'), { id: '200', name: 'Post', type: 11, guildId: '300', parentId: '400', parentName: null })
  for (const source of [{ ...origin(), projectId: 'other' }, { ...origin(), botInstanceId: 'other' },
    { ...origin(), conversationId: '201' }, { ...origin(), parentId: undefined }, { ...origin(), guildId: undefined },
    { ...origin(), recipientId: '900' }, { ...origin(), platform: 'qq' }]) {
    assert.equal(discordChannelNavigation({ ...state, channelSource: source }, 'p'), undefined)
  }
  assert.equal(discordChannelNavigation({ ...state, sessionId: 'channel-inbox:bad%' }, 'p'), undefined)
})

test('ordinary text channels with category parents are not converted to threads', () => {
  const b = boundary(); b.location.type = 0
  assert.equal(discordChannelNavigation({ projectId: 'p', sessionId: 'bot:p:connection:discord:200', channelBoundary: b }, 'p')?.type, 0)
  assert.equal(discordChannelNavigation({ projectId: 'p', sessionId: 'web:chat', channelBoundary: b }, 'p'), undefined)
})
