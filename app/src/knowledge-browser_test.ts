import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { extractLinks } from '../../src/knowledge/links.ts'
import type { KnowledgeDetail } from './knowledge.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('knowledge Markdown links navigate real previews without weakening sanitization', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `knowledge-links-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const detail = (id: string, title: string, content: string): KnowledgeDetail => ({
    entry: { id, path: id, title, kind: id.includes('skills/') ? 'skill' : 'wiki',
      source: id.startsWith('builtin:') ? 'builtin' : 'project', deletable: !id.startsWith('builtin:'), revision: 'fixture' },
    content,
  })
  const docs = [
    detail('memory/topics/index.md', 'Operations wiki', [
      '# Operations wiki',
      '[**Relative page**](guide.md#install)',
      '[Alias page](v:memory/topics/guide.md)',
      '[Skill](v:skills/fixture)',
      '[Built-in](builtin:skills/fixture)',
      '[Reference page][ref]', '[ref]: guide.md#install',
      '[Encoded page](guide%20space.md)',
      '[Entity page](guide&amp;space.md)',
      '[Local section](#local-section)', '[Chinese section](#%E4%B8%AD%E6%96%87%E7%AB%A0%E8%8A%82)',
      '[Missing section](#missing-section)', '[Invalid section](#bad%escape)',
      '[Missing page](missing.md)', '[Unsupported](../../../outside.md)',
      '[Web](https://example.com/docs?q=1&view=2)', '[Mail](mailto:team@example.com)',
      '[Unsafe](javascript:alert%281%29)', '[Data](data:text/html,bad)', '[File](file:///etc/passwd)',
      '<a href="javascript:alert(1)" onclick="alert(1)">Unsafe HTML</a>',
      '<img src=x onerror="window.__unsafe=true"><script>window.__unsafe=true</script>',
      '<a data-knowledge-id="memory/topics/guide.md" href="https://example.com/raw">Raw web</a>',
      ...Array.from({ length: 25 }, (_, i) => `Paragraph ${i}.`),
      '## Local section', 'Local target.',
      '## 中文章节', 'Chinese target.',
      '## Local section', 'Repeated heading.',
    ].join('\n\n')),
    detail('memory/topics/guide.md', 'Linked guide', [
      '# Linked guide', ...Array.from({ length: 25 }, (_, i) => `Guide paragraph ${i}.`), '## Install', 'Install target.',
    ].join('\n\n')),
    detail('memory/topics/guide space.md', 'Encoded guide', '# Encoded guide'),
    detail('memory/topics/guide&space.md', 'Entity guide', '# Entity guide'),
    detail('builtin:skills/fixture', 'Fixture skill', '# Fixture skill\n\n[Return](v:memory/topics/index.md)'),
  ]
  const catalog = {
    entries: docs.map(doc => doc.entry),
    links: docs.flatMap(doc => extractLinks(doc, directory, new Map([['fixture', 'builtin:skills/fixture']]))),
  }
  const reads: string[] = []
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'marked', 'dompurify'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-knowledge-links',
      resolveId: id => id === '/knowledge-fixture.ts' ? '\0knowledge-fixture' : undefined,
      load(id) {
        if (id !== '\0knowledge-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import {createApp, h} from 'vue';
          import {createRouter, createMemoryHistory} from 'vue-router';
          import KnowledgeView from '/src/components/KnowledgeView.vue';
          const router=createRouter({history:createMemoryHistory(),routes:[
            {name:'chat',path:'/projects/:projectId/chat',component:{}}
          ]});
          const initial=new URLSearchParams(location.search);
          await router.push({name:'chat',params:{projectId:'fixture'},query:{panel:'knowledge',entry:initial.get('entry')||'memory/topics/index.md'},hash:location.hash});
          window.__knowledge={select:(id,hash='')=>router.push({name:'chat',params:{projectId:'fixture'},query:{panel:'knowledge',entry:id},hash}),router};
          createApp({render:()=>h(KnowledgeView,{
            apiBase:location.origin+'/projects/fixture',projectId:'fixture',
            entryId:router.currentRoute.value.query.entry,
            onSelect:id=>window.__knowledge.select(id),
            style:'height:100dvh',
          })}).use(router).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://fixture')
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          if (url.pathname === '/__knowledge') {
            response.setHeader('Content-Type', 'text/html')
            response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws:")
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/knowledge-fixture.ts"></script></body></html>')
          } else if (url.pathname.endsWith('/api/knowledge/entry')) {
            const id = url.searchParams.get('id')!
            reads.push(id)
            json(docs.find(doc => doc.entry.id === id))
          } else if (url.pathname.endsWith('/api/knowledge')) json(catalog)
          else if (url.pathname.endsWith('/api/knowledge/maintenance')) json({ intervalMs: 86_400_000, scanning: false, report: null })
          else next()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'knowledge-links-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { KNOWLEDGE_LINKS_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /KNOWLEDGE_LINKS_OK/)
  assert(!reads.includes('memory/topics/missing.md'), 'Missing catalog targets never cause an arbitrary file read')
  assert(reads.includes('builtin:skills/fixture'))
})
