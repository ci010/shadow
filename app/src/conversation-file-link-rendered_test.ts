import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('conversation links open scoped previews and reveal nested files without navigating away', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `file-links-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const { descriptor } = parse(await readFile(resolve(root, 'app', 'src', 'components', 'ChatTab.vue'), 'utf8'))
  const script = descriptor.scriptSetup!.content
  const attachments = [...descriptor.template!.content.matchAll(/<MessageAttachments\b[\s\S]*?\/>/g)]
  assert.equal(attachments.length, 2, 'History and streaming attachments share the tab-opening action')
  for (const [template] of attachments) {
    assert.match(template, /:workdir="currentWorkdir"/)
    assert.match(template, /@open="workbench\?\.openLinkedFile\(\$event\)"/)
  }
  const start = script.indexOf('function openConversationLink(')
  const end = script.indexOf('const marked =', start)
  assert.ok(start >= 0 && end > start)
  const handler = ts.transpileModule(script.slice(start, end), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  }).outputText
  const requests: string[] = []
  const mediaRequests: string[] = []
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'file-link-fixture',
      resolveId: id => id === '/file-links.ts' ? '\0file-links' : undefined,
      load(id) {
        if (id !== '\0file-links') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref } from 'vue';
          import { marked } from 'marked';
          import DOMPurify from 'dompurify';
          import Workbench from '/src/components/files/FileWorkbench.vue';
          import Attachments from '/src/components/MessageAttachments.vue';
          import { messageAttachments } from '/src/message-attachments.ts';
          import { conversationFileLink } from '/src/conversation-file-link.ts';
          import { conversationLinkSession } from '/src/project-coordination.ts';
          import { imagePreviewFromEvent } from '/src/image-viewer.ts';
          createApp({ setup() {
            const props = {projectId:'fixture', apiBase:location.origin + '/projects/fixture'};
            const activeSessionId = ref('web:chat-fixture');
            const workbench = ref();
            const requestSession = () => { throw new Error('Unexpected conversation navigation') };
            const openImagePreview = () => { throw new Error('Unexpected image preview') };
            ${handler}
            const markdown = '[Daily report](reports/daily/REPORT.md)\\n\\n[Unlisted report](unlisted.md)\\n\\n[Missing](missing.md)\\n\\n[External](https://example.invalid/report.md)';
            const attachments = messageAttachments('MEDIA:reports/daily/REPORT.md\\nMEDIA:C:\\\\synthetic\\\\owner\\\\review notes\\\\自我介绍.md');
            return () => h(Workbench, {ref:workbench, apiBase:props.apiBase, sessionId:activeSessionId.value,
              contextKey:'fixture', active:true, style:'height:100vh'}, {
              default:() => [
                h('article', {class:'fixture-message', onClick:openConversationLink,
                  innerHTML:DOMPurify.sanitize(marked.parse(markdown))}),
                h(Attachments, {paths:attachments.paths, apiBase:props.apiBase, sessionId:activeSessionId.value,
                  workdir:{kind:'local',displayPath:'C:\\\\synthetic\\\\owner'},
                  onOpen:file => workbench.value.openLinkedFile(file)}),
              ],
            });
          }}).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          if (url.pathname === '/__file-links') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<html><body style="margin:0"><div id="app"></div><script type="module" src="/file-links.ts"></script></body></html>')
            return
          }
          if (url.pathname === '/projects/fixture/api/media') {
            mediaRequests.push(url.search)
            if (request.headers['x-fixture-renderer'] !== 'allowed') {
              response.statusCode = 401
              response.end('unauthorized')
            } else {
              response.setHeader('Content-Type', 'application/octet-stream')
              response.end('Attachment download')
            }
            return
          }
          if (!url.pathname.startsWith('/projects/fixture/api/sessions/')) return next()
          requests.push(url.pathname + url.search)
          response.setHeader('Content-Type', 'application/json')
          const path = url.searchParams.get('path') ?? ''
          const entry = (name: string, type = 'file') => ({ name, type, ext: type === 'file' ? '.md' : '', size: 20, mtime: null })
          if (url.pathname.endsWith('/files')) {
            const entries = path === '' ? [entry('reports', 'dir')]
              : path === 'reports' ? [entry('daily', 'dir')]
              : path === 'reports/daily' ? Array.from({ length: 40 }, (_, i) => entry(`a-${i}.md`)).concat(entry('REPORT.md')) : []
            response.end(JSON.stringify({ path, entries }))
          } else if (url.pathname.endsWith('/raw')) {
            if (request.headers['x-fixture-renderer'] !== 'allowed') {
              response.statusCode = 401
              response.end(JSON.stringify({ error: 'unauthorized' }))
            } else if (path === 'missing.md') {
              response.statusCode = 404
              response.end(JSON.stringify({ error: 'file_not_found' }))
            } else {
              response.setHeader('Content-Type', 'text/markdown')
              response.end('# Downloaded ' + path)
            }
          } else if (url.pathname.endsWith('/preview')) {
            if (path === 'missing.md') { response.statusCode = 404; response.end(JSON.stringify({ error: 'file_not_found' })) }
            else response.end(JSON.stringify({ binary: false, size: 20, content: '# Preview ' + path }))
          } else if (url.pathname.endsWith('/git/status')) response.end(JSON.stringify({ available: false, reason: 'not_repository' }))
          else { response.statusCode = 404; response.end('{}') }
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'conversation-file-link-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { FILE_LINK_URL: url, FILE_LINK_SCREENSHOTS: process.env.FILE_LINK_SCREENSHOTS }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, log)
  assert.match(log, /FILE_LINK_SMOKE_OK/)
  assert.ok(requests.some(url => url.includes('/preview?path=reports%2Fdaily%2FREPORT.md')))
  assert.ok(requests.some(url => new URL(url, 'http://fixture').searchParams.get('path') === 'review notes/自我介绍.md'))
  assert.deepEqual(mediaRequests.map(query => Object.fromEntries(new URLSearchParams(query))), [
    { chatId: 'chat-fixture', path: 'reports/daily/REPORT.md', download: '1' },
  ])
  assert.ok(requests.every(url => url.startsWith('/projects/fixture/api/sessions/web%3Achat-fixture/')))
})
