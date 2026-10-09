import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { type TestContext } from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import ts from 'typescript'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

const renderedOptions = {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}
test('conversation presentation and compacted history render across themes and viewport sizes', renderedOptions, t => renderConversation(t))
test('system events preserve hierarchy, navigation and metadata across themes and viewport sizes', renderedOptions, t => renderConversation(t, 'events'))
test('coordinator progress and outgoing message links navigate from the embedded primary pane', renderedOptions, t => renderConversation(t, 'coordinator-navigation'))
test('received and outgoing session messages have explicit English and Chinese direction at desktop and mobile widths', renderedOptions, t => renderConversation(t, 'message-direction'))
test('session exchanges use fixed-height preview cards with accessible animated expansion', renderedOptions, t => renderConversation(t, 'session-exchanges'))
test('call and task responses share five-line faded preview cards and the tool rail width', renderedOptions, t => renderConversation(t, 'response-cards'))
test('conversation reading rail owns width while Markdown fills cards across desktop and mobile', renderedOptions, t => renderConversation(t, 'reading-layout'))

async function renderConversation(t: TestContext, scenario: 'presentation' | 'events' | 'coordinator-navigation' | 'message-direction' | 'session-exchanges' | 'response-cards' | 'reading-layout' = 'presentation') {
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
  const continuityStart = template.indexOf('<details v-if="unlinkedExecutions.length"')
  assert(continuityStart >= 0 && continuityStart < start)
  const segmentNavigation = template.match(/<SegmentNavigation[\s\S]*?\/>/)?.[0]
  assert.ok(segmentNavigation)
  const compiled = compileTemplate({
    source: `<div :class="{ 'mobile-chat': mobileLayout }">
      <div v-if="compactionFixture" class="conversation-heading-row"><SessionHeading :api-base="apiBase" :session-id="activeSessionId"
        name="Daily preliminary review" project-name="Default" :topic="headingTopic" :physical-id="viewingPhysicalId"
        :revision="0" :active="true" :can-rename="true" />${segmentNavigation}</div>
      <div class="chat-history" :style="readingLayout ? {height:'calc(100vh - 160px)'} : undefined">
      <div :class="readingLayout ? 'chat-messages' : undefined" :style="readingLayout ? undefined : {display:'contents'}">
      <div class="chat-message-list">${skeleton}${template.slice(continuityStart, end)}
      <div class="fixture-stages"><SessionActivity v-for="stage in ['idle', 'llm', 'tool', 'waiting', 'completed', 'failed']" :key="stage" :stage="stage" /></div>
      </div></div></div>
      <div v-if="readingLayout" class="chat-composer"><div class="composer-box"><div class="composer-input"><textarea aria-label="Message" placeholder="Message..." /></div></div></div>
      </div>`,
    filename: 'ConversationRows.vue', id: 'data-v-fixture', scoped: true,
  })
  assert.deepEqual(compiled.errors, [])
  const styles = compileStyle({
    source: descriptor.styles.map(style => style.content).join('\n'),
    filename: 'ConversationRows.vue', id: 'data-v-fixture', scoped: true,
  })
  assert.deepEqual(styles.errors, [])
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
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
          import { i18n, t, formatNumber } from '/src/i18n.ts';
          window.__setConversationLocale = locale => { i18n.global.locale.value = locale };
          import DOMPurify from 'dompurify'; import { marked } from 'marked';
          import MessageAction from '/src/components/MessageAction.vue';
          import ExecutionMessage from '/src/components/ExecutionMessage.vue';
          import ConversationEvent from '/src/components/ConversationEvent.vue';
          import ConversationSkeleton from '/src/components/ConversationSkeleton.vue';
          import ToolActivityGroup from '/src/components/ToolActivityGroup.vue';
          import YieldDecision from '/src/components/YieldDecision.vue';
          import SessionMessageDisclosure from '/src/components/SessionMessageDisclosure.vue';
          import { inlineYieldDecisions } from '/src/yield-history.ts';
          import MessageTimestamp from '/src/components/MessageTimestamp.vue';
          import SessionActivity from '/src/components/SessionActivity.vue';
          import SessionHeading from '/src/components/SessionHeading.vue';
          import SegmentNavigation from '/src/components/SegmentNavigation.vue';
          import ConversationSummary from '/src/components/ConversationSummary.vue';
          import ResponseDisclosure from '/src/components/ResponseDisclosure.vue';
          import { isBackgroundResponse } from '/@fs/${resolve(root, 'src', 'sessions', 'response-context.ts').replaceAll('\\', '/')}';
          import { inlineMessageActions } from '/src/message-actions.ts';
          import { groupToolActivity } from '/src/tool-activity.ts';
          import { messageAttachments } from '/src/message-attachments.ts';
          import { sessionMessageTitle } from '/src/message-author.ts';
          import { useConversationNavigation } from '/src/composables/useConversationNavigation.ts';
          import { render } from '/conversation-rows.js';
          const state = reactive({ loadingHistory:true, messages:[], visible:true, conversationDocumentVisible:true,
            readingLayout:false, mobileLayout:false,
            activePanel:'conversation', route:{name:'chat'}, viewingPhysicalId:null, activeSessionId:'web:owner',
            streaming:false, streamContent:'', isDirectChat:true, requestBusy:false, currentRecovery:null,
            embedded:false, enableChildPane:false, navigation:[], apiBase:location.origin, decisionRecords:[], decisionRecordError:'', installation:{uiScopes:[]},
            compactionFixture:false, previousPhysicalId:null, unlinkedExecutions:[], childSessionId:null,
            executionFixtures:{11:{mode:'task',label:'Compile and finish native helper',agentType:'sub',
              sessionId:'web:peer',stage:'completed',blocked:false,arguments:'{"mode":"task"}',receipt:'Task completed.'}},
            headingTopic:{ title:'Daily preliminary review', goal:'Preserve independently verifiable review results.',
              scope:'Review the current theme and brand kit.\\nDocument changes since the previous review.',
              nonGoals:'Do not publish or change the source materials.' } });
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
            { role:'assistant', event:'tool_call', content:'', toolCallId:'decision',
              toolCall:{ name:'ask', arguments:{question:'Increase the experiment budget?',options:['Six runs','Four runs'],default_option:'Four runs'} } },
            { role:'tool', event:'tool_result', toolCallId:'decision',
              content:JSON.stringify({requestId:'budget',option:'Four runs',answeredBy:'timeout',answeredAt:'2026-09-21T10:00:00Z'}) },
            { role:'assistant', content:'The background review failed. The original changes are untouched.',
              responseContext:{version:1,turnId:'background-turn',responseId:'background-response',userInvolved:false,
                source:{kind:'event',eventId:'review-failed',type:'subagent-failed',source:'Reviewer',status:'failed'}} },
            { role:'user', isSystemEvent:true, eventMeta:{ type:'subagent-failed', source:'Reviewer',
              attrs:{type:'subagent-failed',mode:'task','source-session-id':'web:peer'} },
              content:'## terminated', timestamp:'2026-09-21T10:01:00Z' },
            { role:'assistant', event:'tool_call', content:'', toolCallId:'delegate',
              toolCall:{name:'subagent',arguments:{mode:'task',description:'Compile and finish native helper'}} },
            { role:'tool', event:'tool_result', toolCallId:'delegate', content:'Task completed.' },
            { role:'user', isSystemEvent:true, eventMeta:{type:'work-realignment',source:'work-contract',
              attrs:{type:'work-realignment','event-id':'work:fixture',source:'work-contract'}},
              content:'Work work:fixture changed. Read its current context and assignment; stop obsolete actions. Only its current executor may adopt and resume. No permission or acceptance is implied.\\n' +
                JSON.stringify({key:'work:fixture',revision:1,assignee:'web:chat-' + 'long-session-id-'.repeat(8)}) },
          ];
          Object.assign(window, { __conversationFixture:state, __showConversation:() => { state.messages = samples; state.loadingHistory = false } });
          window.__showResponses = () => {
            const content = '## Review outcome\\n\\nA **verified** result with \`inline code\`.\\n\\n' +
              '- First finding\\n- Second finding\\n\\n\`\`\`ts\\nconst result = 1\\n\`\`\`\\n\\n' + 'Detailed evidence remains available. '.repeat(40);
            state.loadingHistory = false; state.navigation = [];
            state.executionFixtures = {
              0:{mode:'call',label:'Context review',sessionId:'web:peer',stage:'completed',blocked:false,output:content,arguments:'{"mode":"call"}',receipt:'Completed'},
              1:{mode:'task',label:'Task failure with partial work',sessionId:'web:peer',stage:'failed',blocked:false,output:content,partialWork:'Partial work is not a successful result.',arguments:'{"mode":"task"}',receipt:'Failed'},
            };
            state.messages = [
              {role:'assistant',event:'tool_call',content:'',toolCallId:'call-response'},
              {role:'assistant',event:'tool_call',content:'',toolCallId:'task-failure'},
              {role:'user',isSystemEvent:true,content,eventMeta:{type:'subagent-complete',source:'subagent',
                attrs:{mode:'task','event-id':'task-result','source-session-id':'web:peer'}}},
              {role:'user',isSystemEvent:true,content,eventMeta:{type:'subagent-cancelled',source:'legacy worker',
                attrs:{mode:'call','event-id':'legacy-result'}}},
              {role:'assistant',content},
              {role:'assistant',event:'tool_call',content:'',toolCallId:'ordinary-read',toolCall:{name:'read',arguments:{path:'file.ts'}}},
              {role:'tool',event:'tool_result',toolCallId:'ordinary-read',content:'File contents'},
            ];
          };
          window.__showReadingLayout = () => {
            window.__showConversation();
            const content = '## Review outcome\\n\\n' + 'The response fills the shared reading rail. '.repeat(16) +
              '\\n\\nFirst source line.\\nSecond source line.\\n\\n- Preserve **Markdown** and \`inline code\`.\\n\\n\`\`\`ts\\nconst evidence = "' + '0123456789'.repeat(120) + '"\\n\`\`\`';
            state.readingLayout = true;
            state.executionFixtures = {4:{mode:'call',label:'Review result',sessionId:'web:peer',stage:'completed',blocked:false,
              output:content,arguments:'{"mode":"call"}',receipt:'Completed'}};
            state.messages = [
              {role:'user',content:'Please review.'},
              {role:'user',content,sessionSource:{id:'web:peer',intent:'handoff'}},
              {role:'assistant',event:'tool_call',content:'',toolCallId:'send',
                toolCall:{name:'message',arguments:{sessionId:'web:peer',content}}},
              {role:'tool',event:'tool_result',toolCallId:'send',content:'Message sent to web:peer. Queued for a response.'},
              {role:'assistant',event:'tool_call',content:'',toolCallId:'call-result'},
              {role:'user',isSystemEvent:true,content,timestamp:'2026-10-08T08:30:00Z',
                eventMeta:{type:'subagent-complete',source:'subagent',attrs:{mode:'task','event-id':'reading-task','source-session-id':'web:peer'}}},
              {role:'assistant',content},
              {role:'assistant',event:'tool_call',content:'',toolCallId:'read',
                toolCall:{name:'read',arguments:{path:'file.ts'}}},
              {role:'tool',event:'tool_result',toolCallId:'read',content:'File contents'},
              {role:'user',isSummary:true,content},
            ];
          };
          window.__showEvents = () => {
            Object.assign(state, { compactionFixture:false, previousPhysicalId:null, unlinkedExecutions:[],
              viewingPhysicalId:null, decisionRecords:[], navigation:[], childSessionId:null, embedded:false });
            state.messages = [
              {role:'user',isSystemEvent:true,timestamp:'2026-09-16T12:34:05Z',
                eventMeta:{type:'agent-start',source:'cron',attrs:{type:'agent-start',source:'cron','event-id':'start:fixture',
                  'source-session-id':'web:peer','source-label':'Encapsulate recurring complexity into a skill, tool/CLI, or dedicated agent.'}},
                content:'Encapsulate: read the event log and referenced wiki items.\\n\\nPreserve recurring complexity as a skill, tool/CLI, or dedicated agent.'},
              {role:'user',isSystemEvent:true,timestamp:'2026-09-16T12:35:05Z',
                eventMeta:{type:'subagent-complete',source:'subagent',attrs:{type:'subagent-complete',mode:'task',
                  'event-id':'complete:fixture','source-session-id':'web:peer','source-label':'Review recurring complexity'}},
                content:'The execution completed. Its learning outcome still requires a verified receipt.'},
              {role:'user',isSystemEvent:true,timestamp:'2026-09-16T12:36:05Z',
                eventMeta:{type:'subagent-failed',source:'subagent',attrs:{type:'subagent-failed',mode:'call',
                  'event-id':'failed:fixture','source-session-id':'web:peer','source-label':'Verify the referenced wiki items'}},
                content:'The execution failed. No verified learning outcome is available.'},
              {role:'user',isSystemEvent:true,
                eventMeta:{type:'subagent-cancelled',source:'subagent',attrs:{type:'subagent-cancelled',mode:'task','event-id':'cancelled:fixture'}},
                content:'The execution was cancelled before it finished.'},
              {role:'user',isSystemEvent:true,
                eventMeta:{type:'subagent-complete',source:'legacy worker',attrs:{type:'subagent-complete','event-id':'legacy:fixture'}},
                content:'This historical completion has no linked execution.'},
              {role:'user',isSystemEvent:true,
                eventMeta:{type:'external-notification',source:'external-' + 'long-source-'.repeat(20),
                  attrs:{title:'External notification / ' + 'LongTitle'.repeat(24),'event-id':'external:fixture',
                    ['long-metadata-key-'.repeat(8)]:'unbroken-identifier-'.repeat(40)}},
                content:'Reference: ' + 'LongReference'.repeat(40)},
              {role:'user',isSystemEvent:true,
                eventMeta:{type:'exec-complete',source:'exec',attrs:{title:'exec: pnpm lint',
                  'event-id':'own-background:fixture','source-session-id':'web:owner'}},
                content:'(no output, exit code 0)'},
              {role:'user',isSystemEvent:true,
                eventMeta:{type:'subagent-complete',source:'subagent',attrs:{type:'subagent-complete',
                  'event-id':'own-completion:fixture','source-session-id':'web:owner'}},
                content:'Own completion remains readable.'},
              {role:'user',isSystemEvent:true,
                eventMeta:{type:'exec-complete',source:'exec',attrs:{title:'exec: pnpm lint',
                  'event-id':'peer-background:fixture','source-session-id':'web:peer'}},
                content:'Peer background task finished.'},
            ];
          };
          window.__showCompaction = () => {
            state.compactionFixture = true; state.previousPhysicalId = 'previous-segment'; state.streaming = false;
            state.decisionRecords = []; state.decisionRecordError = ''; state.embedded = false; state.navigation = [];
            state.messages = [{role:'user', isSummary:true, content:'## Previous Conversation Summary\\n\\n' +
              'Earlier context is preserved for this conversation.\\n\\n### Review outcome\\n\\n' +
              '- Review of the theme is complete.\\n- Follow-up findings remain available in the execution traces.\\n\\n' +
              '### Reference\\n\\n' + 'LongReference'.repeat(35)}];
            state.unlinkedExecutions = [
              {sessionId:'web:peer',label:'Theme preliminary review with a deliberately long execution title'},
              {sessionId:'web:peer-2',label:'Verify the review deliverables and scope'},
              {sessionId:'web:peer-3',label:'Brand kit review / ' + 'UnbrokenTitle'.repeat(24)},
            ];
          };
          const empty = { render:() => null };
          createApp({
            __scopeId:'data-v-fixture',
            components:{ MessageAction, ConversationSkeleton, ToolActivityGroup, MessageTimestamp, SessionActivity, YieldDecision, SessionMessageDisclosure,
              SessionHeading, SegmentNavigation, ConversationSummary, ResponseDisclosure, ExecutionMessage, ConversationEvent, CommandResult:empty,
              MessageAttachments:empty, IoRequestCard:empty },
            render,
            setup() {
              const expandedResponses = reactive(new Set());
              const sessions = [{ sessionId:'web:peer', label:'Reviewer with a deliberately long name', mode:'session' }];
              const messageActions = computed(() => inlineMessageActions(state.messages, sessions));
              const yieldDecisions = computed(() => inlineYieldDecisions(state.messages, null, state.decisionRecords));
              const nav = useConversationNavigation({
                props:{ managed:true, get embedded() { return state.embedded }, get enableChildPane() { return state.enableChildPane },
                  sessionId:'web:owner', projectId:'fixture' },
                router:{replace(){}}, emit:(event, id) => state.navigation.push({event,id}),
                sessions:() => sessions, reset(){}, refresh(){}, mounted:() => true, newDraft(){},
              });
              return { ...toRefs(state), t, formatNumber, messageActions, yieldDecisions, SessionMessageDisclosure,
                expandedResponses, isBackgroundResponse,
                setResponseExpanded(context, open) { if (!context) return; if (open) expandedResponses.add(context.responseId); else expandedResponses.delete(context.responseId) },
                displayMessages:computed(() => state.messages.map(msg => ({ ...msg, attachmentBody:messageAttachments(msg.content) }))),
                inlineExecutions:computed(() => ({entries:new Map(Object.entries(state.executionFixtures).map(([index, value]) => [Number(index), value]))})),
                ioAfter:new Map(), expandedThinking:new Set(),
                toolActivity:computed(() => groupToolActivity(state.messages, new Set([...messageActions.value.excluded, ...yieldDecisions.value.excluded,
                  ...Object.keys(state.executionFixtures).map(Number), 12]))),
                inspectExecution:nav.inspectExecution, sourceForEvent:meta => meta.attrs['source-session-id'] ? ({
                  ...sessions[0],sessionId:meta.attrs['source-session-id'],
                  mode:meta.type === 'exec-complete' || meta.attrs['source-session-id'] === 'web:owner' ? 'session' : 'task',
                  label:meta.attrs['source-label'] || sessions[0].label,
                }) : undefined,
                eventSourceSession:meta => meta.attrs['source-session-id'], clearSelection(){}, openImagePreview(){}, refreshDecisionRecords(){}, sessionMessageTitle,
                viewPreviousSegment(){ state.viewingPhysicalId = state.previousPhysicalId },
                goBackToCurrentSegment(){ state.viewingPhysicalId = null },
                viewNextSegment(){ state.viewingPhysicalId = null },
                renderMarkdown:text => DOMPurify.sanitize(marked.parse(text, {breaks:true})), isErrorMessage:() => false };
            },
          }).use(i18n).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const details = request.url?.match(/^\/api\/sessions\/([^/]+)\/details(?:\?|$)/)
          if (details) {
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({
              sessionId: decodeURIComponent(details[1]), name: null,
              workdir: { kind: 'local', displayPath: 'C:\\synthetic\\review' },
              usage: null, usageScope: 'session', context: { usedTokens: 2400, windowTokens: 100000 },
            }))
            return
          }
          if (request.url?.startsWith('/api/sessions/web%3Aowner/decisions')) {
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(request.url.includes('/reviews') ? { reviews: [] } : { records: [{
              request: { id: 'budget', sessionId: 'web:owner', question: 'Increase the experiment budget?',
                options: ['Six runs', 'Four runs'], defaultOption: 'Four runs', recipient: { kind: 'user', sessionId: 'web:owner' },
                createdAt: '2026-09-21T10:00:00Z', deadline: null, origin: { physicalId: 'owner-0', toolCallId: 'decision' },
                sources: [{ sessionId: 'web:peer', physicalId: 'worker-segment-0', requestId: 'worker-budget' }] },
            }] }))
            return
          }
          if (request.url?.startsWith('/api/sessions/web%3Apeer/decisions')) {
            const url = new URL(request.url, 'http://127.0.0.1')
            assert.equal(url.searchParams.get('physicalId'), 'worker-segment-0')
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify({ records: [{
              request: { id: 'worker-budget', sessionId: 'web:peer', question: 'The runner can retry up to six times, exceeding the four-run budget. Should retries be capped?',
                options: ['Cap retries', 'Expand budget'], defaultOption: 'Cap retries', recipient: { kind: 'user', sessionId: 'web:peer' },
                createdAt: '2026-09-21T09:00:00Z', deadline: null, origin: { physicalId: 'worker-segment-0', toolCallId: 'worker-call' } },
            }] }))
            return
          }
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
  if (scenario === 'events') env.CONVERSATION_EVENTS_ONLY = '1'
  if (scenario === 'coordinator-navigation') env.CONVERSATION_NAVIGATION_ONLY = '1'
  if (scenario === 'message-direction') env.CONVERSATION_DIRECTION_ONLY = '1'
  if (scenario === 'session-exchanges') env.CONVERSATION_EXCHANGES_ONLY = '1'
  if (scenario === 'response-cards') env.CONVERSATION_RESPONSE_CARDS_ONLY = '1'
  if (scenario === 'reading-layout') env.CONVERSATION_READING_LAYOUT_ONLY = '1'
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
}
