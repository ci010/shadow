import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import { ChannelSourceSchema, passiveChannelId, type ChannelSource } from './passive-contract.ts'
import { discordChannelNavigation } from './discord-navigation.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { projectDiscordChannels } from '../../app/src/discord-navigation.ts'
import type { SidebarSession } from '../../app/src/folders-sidebar.ts'

const origin: ChannelSource = { version: 1, projectId: 'p', connectionId: 'connection', platform: 'discord',
  conversationId: '200', kind: 'thread', parentId: '400', guildId: '300', botUserId: '100', name: 'Post' }

for (const Store of [JsonlSessionStore, SqliteSessionStore]) test(`${Store.name}: old Discord origins refresh verified parent names durably`, async () => {
  await withTempWorkspace(async root => {
    const state: SessionState = { ownershipVersion: 2, physicalIdVersion: 2, projectId: 'p', sessionId: passiveChannelId(origin),
      segmentIndex: 0, mode: 'session', channelSource: origin }
    let store = new Store(join(root, 'sessions')); await store.init()
    try {
      await store.saveState(state.sessionId, state)
      const old = (await store.getState(state.sessionId))!
      assert.equal(discordChannelNavigation(old, 'p')?.parentName, null, 'No parent-name invention for legacy records')
      await store.saveState(state.sessionId, { ...old, channelSource: { ...origin, parentName: 'Verified forum' } })
      store.close()
      store = new Store(join(root, 'sessions')); await store.init()
      const refreshed = (await store.getState(state.sessionId))!
      assert.equal(refreshed.channelSource?.parentName, 'Verified forum')
      assert.equal(discordChannelNavigation(refreshed, 'p')?.parentName, 'Verified forum')
      assert.equal(discordChannelNavigation(refreshed, 'other'), undefined)
    } finally { store.close() }
  })
})

test('parent names remain bounded presentation metadata for Discord threads only', () => {
  assert.equal(ChannelSourceSchema.safeParse({ ...origin, parentName: 'x'.repeat(101) }).success, false)
  assert.equal(ChannelSourceSchema.safeParse({ ...origin, kind: 'channel', parentId: undefined, parentName: 'Category' }).success, false)
  assert.equal(ChannelSourceSchema.safeParse({ version: 1, projectId: 'p', connectionId: 'c', platform: 'feishu',
    conversationId: 'thread', kind: 'thread', parentId: 'parent', parentName: 'Discord-only' }).success, false)
})

test('two passive posts project the verified forum name without borrowing a post title or foreign scope', () => {
  const history = (id: string, parentName?: string, connectionId = 'connection'): SidebarSession => {
    const source = { ...origin, conversationId: id, connectionId, ...(parentName ? { parentName } : {}) }
    const sessionId = passiveChannelId(source)
    return { sessionId, projectId: 'p', label: 'Post title', isDirectChat: false, isCurrent: false, parentSessionId: null, depth: 0,
      channelAddress: { projectId: 'p', botInstanceId: connectionId, platform: 'discord', conversationId: id },
      discordChannel: discordChannelNavigation({ sessionId, projectId: 'p', channelSource: source }, 'p') }
  }
  const rows = projectDiscordChannels([history('200', 'Verified forum'), history('201')])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].label, 'Verified forum', 'New evidence also labels an old sibling without rewriting its history')
  const legacy = projectDiscordChannels([history('200'), history('201'), history('202', 'Other forum', 'other')])
  assert.deepEqual(legacy.map(row => row.label), ['400', 'Other forum'], 'Unknown names stay unknown, never crossing connection scope')
})
