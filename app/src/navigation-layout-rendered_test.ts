import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { compileTemplate, parse } from 'vue/compiler-sfc'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Knowledge and conversation controls preserve layout, navigation and global radius tokens', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `navigation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const { descriptor } = parse(readFileSync(resolve(root, 'app', 'src', 'components', 'ChatTab.vue'), 'utf8'))
  const actions = descriptor.template!.content.match(/<button\s+v-if="requestBusy"\s+class="composer-send composer-stop"[\s\S]*?<\/button>\s*<button[\s\S]*?<\/button>/)?.[0]
  assert.ok(actions, 'Use the actual composer action templates, not a fixture copy')
  const compiledActions = compileTemplate({ source: `<div class="composer-submit">${actions}</div>`, filename: 'ComposerActions.vue', id: 'fixture' })
  assert.deepEqual(compiledActions.errors, [])
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-navigation',
      resolveId: id => ['/navigation-fixture.ts', '/composer-actions.js', '/composer-style.css'].includes(id) ? `\0${id}` : undefined,
      load(id) {
        if (id === '\0/composer-actions.js') return compiledActions.code
        if (id === '\0/composer-style.css') return descriptor.styles.map(style => style.content).join('\n')
        if (id !== '\0/navigation-fixture.ts') return
        return `import 'uno.css'; import '/src/styles.css';
          import '/composer-style.css';
          import { createApp, computed, h, ref, reactive, toRefs } from 'vue';
          import Knowledge from '/src/components/KnowledgeView.vue';
          import KnowledgeGraph from '/src/components/KnowledgeGraph.vue';
          import Rail from '/src/components/MessageHistoryRail.vue';
          import ConversationEvent from '/src/components/ConversationEvent.vue';
          import YieldDecision from '/src/components/YieldDecision.vue';
          import { inlineYieldDecisions } from '/src/yield-history.ts';
          import { messageHistoryMarkers, groupMessageHistoryMarkers } from '/src/message-history.ts';
          import { render } from '/composer-actions.js';
          const state = reactive({ requestBusy:false, currentRequest:{state:{stopping:false}},
            installation:{uiScopes:['chat:write']}, canSend:true, submissionBusy:false, sent:0, stopped:0 });
          Object.assign(window, { __composerFixture:state });
          const ComposerActions = { render, setup:() => ({ ...toRefs(state),
            sendMessage:() => state.sent++, stopCurrentRequest:() => state.stopped++ }) };
          const catalogEntries = ['memory', 'wiki', 'skill'].map(kind => ({
            id:kind, path:kind + '.md', title:kind, kind, source:'project', deletable:true, revision:'r1',
          }));
          const messages = reactive([
            { role: 'user', content: 'Human request', senderName: 'Alice' },
            { role: 'assistant', content: 'Reply' },
            { role: 'user', content: 'Review progress', sessionSource: { id: 'web:reviewer', intent: 'progress' } },
            { role: 'user', content: 'Review complete', isSystemEvent: true,
              eventMeta: { type: 'subagent-complete', source: 'Worker', attrs: { 'source-session-id': 'task:worker' } } },
          ]);
          createApp({ setup() {
            const mode = ref('knowledge'); const container = ref();
            const pending = ref(null); const list = ref(false);
            Object.assign(window, { __navigationMessages:messages, __setPending:request => pending.value = request, __setHistoryList:value => list.value = value });
            const decisions = computed(() => inlineYieldDecisions(messages, pending.value));
            const entries = computed(() => groupMessageHistoryMarkers(messageHistoryMarkers(messages, [{ sessionId: 'web:reviewer', label: 'Reviewer' }], decisions.value.entries), messages));
            return () => h('div', { style: 'height:100vh;display:flex;flex-direction:column;min-width:0' }, [
              h('button', { id:'switch', onClick: () => mode.value = mode.value === 'knowledge' ? 'chat' : 'composer' }, 'Next surface'),
              mode.value === 'knowledge'
                ? h(Knowledge, { apiBase: location.origin, projectId: 'fixture', active: false })
                : mode.value === 'composer' ? h('div', { class:'fixture-composer', style:'padding:20px;min-width:0' }, [
                    h(KnowledgeGraph, { catalog:{entries:catalogEntries,links:[]}, visibleIds:catalogEntries.map(e => e.id), selectedId:'' }),
                    h('div', { class:'resume-bar' }, [h('p', 'Request stopped'), h('button', { class:'resume-button' }, 'Continue')]),
                    h(ComposerActions),
                  ]) : h('div', { class:'fixture-chat', style:'position:relative;flex:1;min-height:0' }, [
                    h('div', { ref:container, class:'fixture-messages', style:'height:100%;overflow:auto' },
                      [...messages.map((msg, index) => decisions.value.entries.has(index)
                        ? h(YieldDecision, {decision:decisions.value.entries.get(index),'data-msg-idx':index})
                        : msg.eventMeta
                        ? h(ConversationEvent, { meta: msg.eventMeta, 'data-msg-idx':index }, () => msg.content)
                        : h('article', { 'data-msg-idx':index, style:'min-height:700px' }, msg.content)),
                       h('div', { style:'height:900px' })]),
                    h(Rail, { entries:entries.value, container:container.value, list:list.value }),
                  ]),
            ]);
          } }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__navigation') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/navigation-fixture.ts"></script></body></html>')
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
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'navigation-layout-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { NAVIGATION_SMOKE_URL: url }
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
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /NAVIGATION_SMOKE_OK/)
})
