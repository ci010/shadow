import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, normalizePath } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('streaming messages explicitly opt into text selection without selecting the bubble chrome', async () => {
  const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(chat, /class="chat-content selectable-text">\s*<span>{{ streamContent }}<\/span>/)
  assert.doesNotMatch(chat, /class="chat-bubble[^"]*selectable-text/)
})

test('content selection whitelist preserves native dragging, editing, copying and quoting', {
  timeout: 120_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `user-select-${randomUUID()}`)
  const fixturePath = normalizePath(resolve(directory, 'selection-fixture.vue'))
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'marked', 'dompurify', 'katex', 'zod'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-user-select',
      resolveId: id => id === '/selection-fixture.vue' ? fixturePath
        : id === '/selection-entry.ts' ? '\0selection-entry' : undefined,
      load(id) {
        if (id === '\0selection-entry') return `import 'uno.css';import '/src/styles.css';import {createApp} from 'vue';import Fixture from '/selection-fixture.vue';createApp(Fixture).mount('#app');`
        if (id !== fixturePath) return
        return `<script setup>
          import {ref} from 'vue';
          import ToolsCard from '/src/components/ToolsCard.vue';
          import ToolPayload from '/src/components/ToolPayload.vue';
          import SystemPromptCard from '/src/components/SystemPromptCard.vue';
          import IoNodes from '/src/components/io/IoNodes.vue';
          import MemoryEventRecord from '/src/components/files/MemoryEventRecord.vue';
          import SelectionMenu from '/src/components/SelectionMenu.vue';
          import CopyableId from '/src/components/CopyableId.vue';
          const content = ref();
          const fixture = {quoted:'',copied:''};
          window.__selectionFixture = fixture;
          Object.defineProperty(navigator,'clipboard',{value:{writeText:async text => {fixture.copied=text}}});
        </script>
        <template>
          <main>
            <nav><span id="navigation">Navigation label</span><button id="navigation-button"><span>Open conversation</span></button></nav>
            <div id="status">Idle status</div><code id="chrome-code">model-id</code>
            <div id="message" ref="content" class="prose">
              <p id="response">Response <strong>bold</strong> and <a href="#message">a readable link</a>.</p>
              <button id="content-button"><span>Copy response</span></button>
              <details open><summary id="disclosure"><span>Details</span></summary><p>Nested readable content</p></details>
            </div>
            <div id="stream" class="selectable-text"><span>Streaming response</span></div>
            <dl><dt id="definition-label">Trace ID</dt><dd id="definition-value"><code>synthetic-trace-id</code></dd></dl>
            <ToolPayload id="payload" source='{"argument":"Synthetic tool content"}' />
            <ToolsCard :tools="[{name:'synthetic',description:'Readable tool description',parameters:{properties:{path:{type:'string',description:'Readable parameter description'}}}}]" />
            <SystemPromptCard prompt="Readable **system prompt**" />
            <SystemPromptCard prompt="Exact raw system prompt" raw />
            <article id="document" class="selectable-text"><p>Readable document body</p><pre><code>source code</code></pre></article>
            <div id="diff"><span class="select-none">123 +</span><pre><span>const value = 1</span></pre></div>
            <button id="thumbnail"><pre class="select-none">Clickable file thumbnail</pre></button>
            <MemoryEventRecord :record="{kind:'event',start:1,end:1,event:{who:'Agent',what:'Readable memory event'},extra:[]}" />
            <IoNodes :nodes="[{id:'text',type:'text',text:'Readable generated output'},{id:'table',type:'table',rows:[['Readable table cell']]},{id:'button',type:'button',text:'Generated action'}]" :disabled="false" />
            <CopyableId value="synthetic-session-id" label="session ID" />
            <input id="input" value="Editable input" /><textarea id="textarea">Editable composer</textarea>
            <div id="editor" contenteditable><span>Editable rich text</span></div>
            <div id="readonly" contenteditable="false">Non-editable chrome</div>
            <SelectionMenu :container="content" active can-quote @quote="text => { fixture.quoted = text }" />
          </main>
        </template>`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__selection') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>body{margin:0}main{padding:16px;max-width:650px}p,pre,dl{margin:12px 0}nav{display:flex;gap:12px}#response{width:max-content;max-width:100%}#editor{padding:8px}#diff{display:flex;gap:8px}</style>
            </head><body><div id="app"></div><script type="module" src="/selection-entry.ts"></script></body></html>`)
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  await server.listen()
  t.after(() => server.close())
  const base = server.resolvedUrls?.local[0]
  assert.ok(base)
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'user-select-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { USER_SELECT_URL: new URL('__selection', base).href }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 90_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  clearTimeout(timer)
  assert.equal(code, 0, output)
  assert.match(output, /USER_SELECT_OK/)
})
