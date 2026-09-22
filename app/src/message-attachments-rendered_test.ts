import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { Hono } from 'hono'
import { WebChannel } from '../../src/channels/web.ts'
import { Bus } from '../../src/bus/bus.ts'
import type { SessionManager } from '../../src/sessions/session-manager.ts'
import { saveToUploads, sessionWorkspacePath } from '../../src/utils/paths.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('chat images open an accessible viewer while media playback and authenticated downloads remain intact', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `media-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const sessionId = 'qq:group-media-fixture'
  const sessionManager = {
    getSessionState: (id: string) => id === sessionId ? { sessionId }
      : id === 'web:chat-child' ? { sessionId: id, workspaceRoot: 'web:owner' } : null,
  } as unknown as SessionManager
  const channel = new WebChannel(new Bus(), { workspace: directory, sessionManager })
  const api = new Hono()
  let videoRequests = 0
  api.use('/api/media', async (c, next) => {
    if (c.req.header('cookie') !== 'fixture-auth=allowed') return c.json({ error: 'unauthorized' }, 401)
    if (c.req.query('download') === '1' && c.req.header('X-Fixture-Renderer') !== 'allowed') return c.json({ error: 'renderer authorization required' }, 401)
    if (c.req.query('path')?.endsWith('.webm')) videoRequests++
    await next()
  })
  await channel.start(api)
  t.after(() => channel.stop())
  await saveToUploads(directory, sessionId, 'logs.zip', Buffer.from('synthetic archive bytes'))
  await saveToUploads(directory, sessionId, 'photo.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aWQAAAABJRU5ErkJggg==', 'base64'))
  const output = resolve(sessionWorkspacePath(directory, 'web:owner'), 'runs', 'review notes', 'report.html')
  await mkdir(resolve(output, '..'), { recursive: true })
  await writeFile(output, '<html>Generated review report</html>')
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-attachments',
      resolveId: id => id === '/media-fixture.ts' ? '\0media-fixture' : undefined,
      load(id) {
        if (id !== '\0media-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref } from 'vue';
          import DOMPurify from 'dompurify';
          import { marked } from 'marked';
          import Attachments from '/src/components/MessageAttachments.vue';
          import ImageViewer from '/src/components/ImageViewer.vue';
          import { imagePreviewFromEvent, imagePreviewMarkup } from '/src/image-viewer.ts';
          import { messageAttachments } from '/src/message-attachments.ts';
          const body = messageAttachments('Attachments from SNS\\n[file: uploads/clip.webm]\\nArchive: MEDIA:uploads/logs.zip', ['uploads/photo.png']);
          const report = messageAttachments(${JSON.stringify(`Report: MEDIA:${output}`)});
          const preview = ref();
          const markdown = ref('');
          const openImage = image => preview.value = image;
          const fromEvent = event => {
            const image = imagePreviewFromEvent(event);
            if (image) { event.preventDefault(); openImage(image); }
          };
          window.__imageFixture = {openImage, close:() => preview.value = undefined,
            markdown:text => markdown.value = imagePreviewMarkup(DOMPurify.sanitize(marked.parse(text)))};
          createApp({ render: () => h('main', {style:'max-width:540px;padding:16px;margin:0 auto;box-sizing:border-box'}, [
            h('p', body.text),
            h(Attachments, { apiBase: location.origin, sessionId: ${JSON.stringify(sessionId)}, paths: body.paths, onPreview:openImage }),
            h(Attachments, { apiBase: location.origin, sessionId: ${JSON.stringify(sessionId)},
              paths: ['uploads/' + 'long-filename-'.repeat(14) + '.zip'] }),
            h(Attachments, { apiBase: location.origin, sessionId:'web:chat-child', paths:report.paths }),
            h('div', {class:'fixture-markdown', innerHTML:markdown.value, onClick:fromEvent, onKeydown:fromEvent}),
            preview.value ? h(ImageViewer, {image:preview.value, onClose:() => preview.value = undefined}) : null,
          ]) }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          if (url.pathname === '/__media') {
            response.setHeader('Content-Type', 'text/html')
            response.setHeader('Set-Cookie', 'fixture-auth=allowed; HttpOnly; SameSite=Strict; Path=/')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/media-fixture.ts"></script></body></html>')
          } else if (url.pathname === '/fixture-video' && request.method === 'POST') {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            await saveToUploads(directory, sessionId, 'clip.webm', Buffer.concat(chunks))
            response.end('saved')
          } else if (url.pathname === '/fixture-count') {
            response.end(String(videoRequests))
          } else if (url.pathname === '/api/media') {
            const headers = new Headers()
            for (const [key, value] of Object.entries(request.headers)) {
              if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value)
            }
            const result = await api.request(url, { method: request.method, headers })
            response.writeHead(result.status, Object.fromEntries(result.headers))
            response.end(Buffer.from(await result.arrayBuffer()))
          } else next()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'message-attachments-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { MEDIA_SMOKE_URL: url, MEDIA_SCREENSHOTS: process.env.MEDIA_SCREENSHOTS }
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
  assert.match(log, /MEDIA_SMOKE_OK/)
  assert(videoRequests > 0)
})
