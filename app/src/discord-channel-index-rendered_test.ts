import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath } from 'node:url'

test('rendered channel index retains separate passive and legacy histories without composer', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, logLevel: 'error', optimizeDeps: { noDiscovery: true }, plugins: [vue()], server: { middlewareMode: true } })
  try {
    const { default: Index } = await server.ssrLoadModule('/src/components/DiscordChannelIndex.vue')
    const histories = ['channel-inbox:passive-original', 'old-original'].map(sessionId => ({ sessionId, projectId: 'p', label: sessionId, channelAddress: { projectId: 'p', botInstanceId: 'b', platform: 'discord', conversationId: '3' }, discordChannel: { id: '3', type: 11, guildId: '2', parentId: '1', parentName: 'Forum', name: 'Thread content' } }))
    let reads = 0
    const app = createSSRApp({ render: () => h(Index, { apiBase: '', projectId: 'p', channelKey: { projectId: 'p', botInstanceId: 'b', guildId: '2', channelId: '1' }, active: true }) })
    app.provide(Symbol.for('shadow.project-live-state'), { acquireProject() { return { graph: { state: { value: histories, loading: false, error: '' }, read: async () => { reads++ } }, release() {} } } })
    const html = await renderToString(app)
    assert.match(html, /Forum/)
    assert.match(html, /Search posts and threads/)
    assert.match(html, /Passive inbox/)
    assert.match(html, /Original history/)
    assert.doesNotMatch(html, /passive-original|old-original/)
    assert.equal((html.match(/class="post"/g) ?? []).length, 1)
    assert.equal(reads, 1)
    assert.doesNotMatch(html, /textarea|contenteditable|session-delete|Send message/)
    const { default: List } = await server.ssrLoadModule('/src/components/FolderSessionList.vue')
    const { projectDiscordChannels } = await server.ssrLoadModule('/src/discord-navigation.ts')
    const list = createSSRApp({ render: () => h(List, { sessions: projectDiscordChannels(histories), activeSessionId: 'old-original', collapsed: new Set(), stages: {}, showInfo: false }) })
    const sidebar = await renderToString(list)
    assert.match(sidebar, /session-list-row active/)
    assert.doesNotMatch(sidebar, /class="session-delete"/)
    assert.match(sidebar, /Forum/)

  } finally { await server.close() }
})
