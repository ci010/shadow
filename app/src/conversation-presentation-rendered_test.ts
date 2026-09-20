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
import { compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('conversation skeleton, incoming alignment and outgoing message navigation render across themes and viewport sizes', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `conversation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const { descriptor } = parse(readFileSync(resolve(root, 'app', 'src', 'components', 'ChatTab.vue'), 'utf8'))
  const template = descriptor.template!.content
  const start = template.indexOf('<template v-for="(msg, idx) in displayMessages"')
  const end = template.indexOf('<IoRequestCard v-for="run in ioAfter.get(-1)"')
  assert(start >= 0 && end > start)
  const skeleton = template.match(/<ConversationSkeleton[\s\S]*?\/>/)?.[0]
  assert.ok(skeleton, 'Use the actual loading condition and activity binding')
  const compiled = compileTemplate({
    source: `<div class="chat-history"><div class="chat-message-list">${skeleton}${template.slice(start, end)}
      <div class="fixture-stages"><SessionActivity v-for="stage in ['idle', 'llm', 'tool', 'waiting', 'completed', 'failed']" :key="stage" :stage="stage" /></div>
      </div></div>`,
    filename: 'ConversationRows.vue', id: 'data-v-fixture', scoped: true,
  })
  assert.deepEqual(compiled.errors, [])
  const styles = compileStyle({
    source: descriptor.styles.map(style => style.content).join('\n'),
    filename: 'ConversationRows.vue', id: 'data-v-fixture', scoped: true,
  })
  assert.deepEqual(styles.errors, [])
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-conversation',
      resolveId: id => ['/conversation-fixture.ts', '/conversation-rows.js', '/conversation-style.css'].includes(id) ? `\0${id}` : undefined,
      load(id) {
        if (id === '\0/conversation-rows.js') return ts.transpileModule(compiled.code, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
        }).outputText
        if (id === '\0/conversation-style.css') return styles.code
        if (id !== '\0/conversation-fixture.ts') return
        return `import 'uno.css'; import '/src/styles.css'; import '/conversation-style.css';
          import { createApp, computed, reactive, toRefs } from 'vue';
          import DOMPurify from 'dompurify'; import { marked } from 'marked';
          import MessageAction from '/src/components/MessageAction.vue';
          import ConversationSkeleton from '/src/components/ConversationSkeleton.vue';
          import ToolActivityGroup from '/src/components/ToolActivityGroup.vue';
          import MessageTimestamp from '/src/components/MessageTimestamp.vue';
          import SessionActivity from '/src/components/SessionActivity.vue';
          import { inlineMessageActions } from '/src/message-actions.ts';
          import { groupToolActivity } from '/src/tool-activity.ts';
          import { messageAttachments } from '/src/message-attachments.ts';
          import { sessionMessageTitle } from '/src/message-author.ts';
          import { useConversationNavigation } from '/src/composables/useConversationNavigation.ts';
          import { render } from '/conversation-rows.js';
          const state = reactive({ loadingHistory:true, messages:[], visible:true, conversationDocumentVisible:true,
            activePanel:'conversation', route:{name:'chat'}, viewingPhysicalId:null, activeSessionId:'web:owner',
            streaming:false, streamContent:'', isDirectChat:true, requestBusy:false, currentRecovery:null,
            embedded:false, navigation:[] });
          const samples = [
            { role:'user', content:'Please ask the reviewer to check the changes.' },
            { role:'user', content:'I will review the changes and send feedback shortly.',
              sessionSource:{ id:'web:peer', intent:'acknowledgement' } },
            { role:'assistant', event:'tool_call', content:'', toolCallId:'send',
              toolCall:{ name:'message', arguments:{ sessionId:'web:peer', content:'Please review **the changes**.\\n\\n' + 'LongContent'.repeat(18) } } },
            { role:'tool', event:'tool_result', toolCallId:'send', content:'Message sent to web:peer. Queued for a response.' },
            { role:'assistant', event:'tool_call', content:'', toolCallId:'read',
              toolCall:{ name:'read', arguments:{ path:'file.ts' } } },
            { role:'tool', event:'tool_result', toolCallId:'read', content:'File contents' },
            { role:'assistant', content:'Review complete. The changes preserve existing behavior.', reasoningText:'Checking the affected paths.' },
          ];
          Object.assign(window, { __conversationFixture:state, __showConversation:() => { state.messages = samples; state.loadingHistory = false } });
          const empty = { render:() => null };
          createApp({
            __scopeId:'data-v-fixture',
            components:{ MessageAction, ConversationSkeleton, ToolActivityGroup, MessageTimestamp, SessionActivity,
              CommandResult:empty, ExecutionMessage:empty, ConversationEvent:empty, ConversationSummary:empty,
              MessageAttachments:empty, IoRequestCard:empty },
            render,
            setup() {
              const sessions = [{ sessionId:'web:peer', label:'Reviewer with a deliberately long name', mode:'session' }];
              const messageActions = computed(() => inlineMessageActions(state.messages, sessions));
              const nav = useConversationNavigation({
                props:{ managed:true, get embedded() { return state.embedded }, projectId:'fixture' },
                router:{replace(){}}, emit:(event, id) => state.navigation.push({event,id}),
                sessions:() => sessions, reset(){}, refresh(){}, mounted:() => true, newDraft(){},
              });
              return { ...toRefs(state), messageActions,
                displayMessages:computed(() => state.messages.map(msg => ({ ...msg, attachmentBody:messageAttachments(msg.content) }))),
                inlineExecutions:{entries:new Map()}, ioAfter:new Map(), expandedThinking:new Set(),
                toolActivity:computed(() => groupToolActivity(state.messages, messageActions.value.excluded)),
                inspectExecution:nav.inspectExecution, clearSelection(){}, openImagePreview(){}, sessionMessageTitle,
                renderMarkdown:text => DOMPurify.sanitize(marked.parse(text)), isErrorMessage:() => false };
            },
          }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__conversation') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/conversation-fixture.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  assert.ok(server.resolvedUrls?.local[0])
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'conversation-presentation-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { CONVERSATION_SMOKE_URL: server.resolvedUrls.local[0] }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'CONVERSATION_SCREENSHOTS']) {
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
  assert.match(output, /CONVERSATION_SMOKE_OK/)
})
