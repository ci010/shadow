import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { sessionsApiPlugin } from './routes.ts'
import type { SessionManager } from './session-manager.ts'

test('full and partial graph expose only display ancestry, never boundary grants', async () => {
  const sessionId = 'channel-inbox:p:connection:discord:200'
  const state = { projectId: 'p', sessionId, segmentIndex: 0, name: 'Post',
    channelSource: { version: 1, projectId: 'p', botInstanceId: 'connection', platform: 'discord', conversationId: '200',
      kind: 'thread', parentId: '400', guildId: '300', botUserId: '100', name: 'Post' } }
  const app = new Hono()
  sessionsApiPlugin({ projectId: 'p',
    listHistorySessions: async () => [{ sessionId, projectId: 'p', segmentIndex: 0 }],
    readSessionState: async () => state, getFirstUserMessage: async () => null,
    getSessionInferenceDefaults: () => ({ model: 'test' }), yields: new Map(), inputs: new Map(),
  } as unknown as SessionManager)(app)
  for (const suffix of ['', `?sessionIds=${encodeURIComponent(JSON.stringify([sessionId]))}`]) {
    const response = await app.request('/api/sessions/graph' + suffix)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.deepEqual(body.sessions[0].discordChannel, { id: '200', name: 'Post', type: 11, guildId: '300', parentId: '400', parentName: null })
    assert.equal(body.sessions[0].channelBoundary, undefined)
  }
})
