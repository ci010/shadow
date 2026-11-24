import assert from 'node:assert/strict'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import type { MessageAction } from './message-actions.ts'

test('outgoing session message hides unconfirmed status but retains the receipt and explicit failures', async t => {
  const server = await createServer({
    root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, logLevel: 'error',
    optimizeDeps: { noDiscovery: true }, plugins: [vue()], server: { middlewareMode: true },
  })
  t.after(() => server.close())
  const { default: Card } = await server.ssrLoadModule('/src/components/MessageAction.vue')
  const { setLocalePreference } = await server.ssrLoadModule('/src/i18n.ts')
  const render = (status: MessageAction['status'], result: string) => renderToString(createSSRApp(Card, {
    message: { status, result, sessionId: 'web:peer', recipient: 'Reviewer', content: 'Please review.', arguments: '{}' },
  }))
  for (const [locale, failure] of [['en', 'Failed'], ['zh-CN', '失败']] as const) {
    setLocalePreference(locale)
    const unknown = await render('unknown', 'Delivery receipt unavailable')
    assert.doesNotMatch(unknown, /message-action-status/)
    assert.match(unknown, /class="session-message-link"/)
    assert.match(unknown, /class="message-action-note"[^>]*>Delivery receipt unavailable/)
    const failed = await render('failed', 'Error: target unavailable')
    assert.match(failed, new RegExp(`role="status"[^>]*>${failure}</span>`))
  }
})
