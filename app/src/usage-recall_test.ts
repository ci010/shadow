import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp, h } from 'vue'
import { renderToString } from 'vue/server-renderer'

test('recall renders active Memory and automatic injection as separate count-only sections', async () => {
  const server = await createServer({
    configFile: false, envFile: false, root: fileURLToPath(new URL('..', import.meta.url)),
    logLevel: 'error', plugins: [vue()], server: { middlewareMode: true, watch: null },
    optimizeDeps: { noDiscovery: true },
  })
  try {
    const { default: Recall } = await server.ssrLoadModule('/src/components/UsageRecall.vue')
    const projects = [{ id: 'fixture', name: 'Fixture', usage: { recall: {
      skills: [{ entry: 'skill-only', reads: 2 }],
      memory: [{ entry: 'active-only', reads: 3, source: 'active' }, { entry: 'injection-only', reads: 7, source: 'automatic' }],
      coverage: 'complete',
    } } }]
    const html = await renderToString(createSSRApp({ render: () => h(Recall, { kind: 'memory', projects }) }))
    const sections = html.match(/<section\b[\s\S]*?<\/section>/g) ?? []
    assert.equal(sections.length, 2)
    assert.match(sections[0]!, /active-only/)
    assert.doesNotMatch(sections[0]!, /injection-only/)
    assert.match(sections[1]!, /injection-only/)
    assert.doesNotMatch(sections[1]!, /active-only/)
    assert.doesNotMatch(html, /ranking-share|%<|Ring chart/)
    assert.match(html, /Legacy\/unknown-origin counts are retained but excluded/)
  } finally { await server.close() }
})
