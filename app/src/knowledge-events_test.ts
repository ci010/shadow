import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { LogTool } from '../../src/tools/log.ts'
import { withTempWorkspace } from '../../src/testing/workspace.ts'
import { parseKnowledgeEvents } from './knowledge-events.ts'

test('event projection consumes the real log writer and preserves source, refs and optional fields', async () => {
  await withTempWorkspace(async root => {
    await new LogTool(root).execute({ who: 'reader', what: 'Selected a safer option', why: 'Avoid data loss', session: 'web:source', refs: ['v:memory/topics/safety.md'] })
    const source = await readFile(join(root, 'memory/events', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8')
    const [row] = parseKnowledgeEvents(source)
    assert.equal(row.line, 1)
    const original = JSON.parse(source.trim())
    assert.deepEqual(row.event, {
      when: original.when,
      who: 'reader',
      what: 'Selected a safer option',
      why: 'Avoid data loss',
      origin: 'web:source',
      refs: ['v:memory/topics/safety.md'],
      summary: undefined,
      challenge: undefined,
    })
    assert.equal(typeof original.id, 'string')
    assert.ok(original.id)
    assert.equal(JSON.parse(row.source).id, original.id)
    assert.equal(row.event?.origin, 'web:source')
    assert.ok(row.event?.when)
  })
})

test('legacy, malformed and wrongly typed fields retain verbatim source without coercion', () => {
  const rows = parseKnowledgeEvents('\n{"what":"legacy"}\n{"when":{},"who":[],"what":4,"refs":[1,"safe"]}\nnull\nbroken\n{"what":"ok","why":{},"refs":[1,"safe"]}')
  assert.equal(rows[0].line, 2)
  assert.equal(rows[0].event?.why, undefined)
  assert.ok(rows.slice(1, 4).every(row => !row.event))
  assert.deepEqual(rows[4].event?.refs, ['safe'])
  assert.equal(rows[4].event?.why, undefined)
})

test('rendered event fields are escaped, missing fields explicit, and refs never become executable URLs', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), envDir: false, configFile: false, logLevel: 'error', optimizeDeps: { noDiscovery: true }, plugins: [vue()], server: { middlewareMode: true } })
  try {
    const { default: Events } = await server.ssrLoadModule('/src/components/KnowledgeEvents.vue')
    const { setLocalePreference } = await server.ssrLoadModule('/src/i18n.ts')
    setLocalePreference('en')
    const html = await renderToString(createSSRApp(Events, { content: JSON.stringify({ when: '2026-01-01', who: '<img src=x onerror=alert(1)>', what: '<script>bad()</script>', refs: ['javascript:bad()', 'v:memory/topics/safe.md'] }) + '\nlegacy plain text', links: [{ source: 'memory/events/day.jsonl', target: 'memory/topics/safe.md', label: 'refs', href: 'v:memory/topics/safe.md' }] }))
    assert.match(html, /What happened/)
    assert.match(html, /Why/)
    assert.match(html, /Not recorded/)
    assert.match(html, /&lt;script&gt;/)
    assert.match(html, /Unrecognized event record/)
    assert.match(html, /<button[^>]*>v:memory\/topics\/safe.md<\/button>/)
    assert.doesNotMatch(html, /<script|<img|href="javascript/)
    assert.match(html, /Recorded source/)
  } finally { await server.close() }
})
