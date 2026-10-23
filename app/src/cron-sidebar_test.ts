import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { parseSessionGraph } from './folders-sidebar.ts'

test('cron graph flag is optional, validated, and never inferred from identity', () => {
  const sessions = parseSessionGraph({ sessions: [
    { sessionId: 'web:target', hasCron: true },
    { sessionId: 'cron:lookalike' },
    { sessionId: 'web:disabled', hasCron: false },
  ], nodes: [] })
  assert.deepEqual(sessions.map(s => s.hasCron), [true, false, false])
  assert.throws(() => parseSessionGraph({ sessions: [{ sessionId: 'web:bad', hasCron: 'true' }], nodes: [] }))
})

test('sidebar renders cron instead of moon only when inactive, below completion and delegated activity', async () => {
  const server = await createServer({
    configFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [vue()], server: { middlewareMode: true }, appType: 'custom',
  })
  try {
    const { default: FolderSessionList } = await server.ssrLoadModule('/src/components/FolderSessionList.vue')
    const render = async (stage: string | undefined, hasCron: boolean, completed = false, child?: string, rail = false) => {
      const sessions = parseSessionGraph({ sessions: [{ sessionId: 'web:target', hasCron, completed }], nodes: [] })
      const executions = child ? [{ sessionId: 'sub-child', mode: 'task', executionStatus: child }] : []
      return renderToString(createSSRApp({ render: () => h(FolderSessionList, {
        sessions, activeSessionId: '', collapsed: new Set(), stages: stage ? { 'web:target': stage } : {},
        executionsByOwner: new Map([['web:target', executions]]), rail, showInfo: false,
      }) }))
    }
    for (const rail of [false, true]) {
      for (const stage of [undefined, 'idle', 'inactive']) {
        assert.match(await render(stage, true, false, undefined, rail), /i-lucide-alarm-clock/)
        assert.match(await render(stage, false, false, undefined, rail), /i-lucide-moon/)
        const completed = await render(stage, true, true, undefined, rail)
        assert.match(completed, /i-lucide-circle-check/)
        assert.doesNotMatch(completed, /i-lucide-alarm-clock|i-lucide-moon/)
      }
    }
    for (const stage of ['llm', 'tool', 'waiting', 'waiting-for-call', 'running', 'pending', 'failed', 'cancelled']) {
      assert.doesNotMatch(await render(stage, true), /i-lucide-alarm-clock|i-lucide-moon/)
    }
    const delegated = await render('idle', true, false, 'running')
    assert.match(delegated, /i-lucide-git-branch/)
    assert.match(delegated, /session-working-wave/)
    assert.doesNotMatch(delegated.match(/activity-symbol[^>]*>(.*?)<\/span>/s)?.[1] ?? '', /working-wave/)
    const ownRunning = await render('running', true)
    assert.match(ownRunning, /activity-symbol[^>]*>[\s\S]*?working-wave/)
    assert.match(ownRunning, /session-working-wave/)
    assert.doesNotMatch(await render('running', true, false, 'running'), /i-lucide-git-branch/)
    assert.match(await render('idle', true, false, 'waiting'), /i-lucide-message-circle-question/)
    for (const child of ['running', 'waiting', 'pending']) {
      assert.doesNotMatch(await render('idle', true, false, child), /i-lucide-alarm-clock|i-lucide-moon/)
    }
  } finally { await server.close() }
})
