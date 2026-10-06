import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test, { type TestContext } from 'node:test'
import * as Vue from 'vue'
import { compileScript, parse } from 'vue/compiler-sfc'
import ts from 'typescript'
import { createLiveRefresh } from './live-refresh.ts'
import type { LiveObserver } from './live-client.ts'
import { sessionActivity } from './session-activity.ts'
import { createProjectLiveState } from './project-live-state.ts'
import type { LiveClient } from './live-client.ts'
import { createResponseContext, isBackgroundResponse, type ResponseContext } from '../../src/sessions/response-context.ts'

const settle = () => new Promise(resolve => setTimeout(resolve, 10))
const root = 'web:chat-parent'
const task = 'web:chat-mode-task'
const graph = () => ({ nodes: [], sessions: [
  { sessionId: root, mode: 'session' },
  { sessionId: task, mode: 'task', parentSessionId: root, parentToolCallId: 'spawn', executionStatus: 'waiting', waitingForCall: false },
] })

function fixture(t: TestContext, canWrite = false) {
  const subscriptions: Array<{ projectId: string; observer: LiveObserver; closed: boolean }> = []
  const requests: Array<{ path: string; signal: AbortSignal; finish: (value: unknown) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: URL, init: RequestInit) => new Promise<Response>(resolve => {
    requests.push({ path: new URL(url).pathname, signal: init.signal!, finish: value => resolve(Response.json(value)) })
  }))
  const pool = { client: (): Pick<LiveClient, 'subscribe'> => ({
    subscribe: (topic, observer) => {
      assert.notEqual(topic.kind, 'projects')
      const subscription = { projectId: topic.projectId!, observer, closed: false }
      subscriptions.push(subscription)
      return { ready: async () => {}, close: () => { subscription.closed = true } }
    },
  }) }
  const liveState = createProjectLiveState(pool, { delayMs: 0 })
  t.after(() => liveState.dispose())
  const url = new URL('./components/ChatTab.vue', import.meta.url)
  const { descriptor } = parse(readFileSync(url, 'utf8'))
  const script = compileScript(descriptor, { id: 'chat-session-live' })
  const module = { exports: {} as { default: Vue.Component & { render?: () => null } } }
  const require = createRequire(url)
  const code = ts.transpileModule(script.content, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  new Function('require', 'module', 'exports', 'window', 'document', code)((id: string) => {
    if (id === 'vue') return { ...Vue, onMounted: () => {} }
    if (id.endsWith('.vue')) return { default: {} }
    if (id === 'vue-router') return { useRoute: () => ({ name: 'chat', query: {}, params: {} }), useRouter: () => ({ replace() {} }) }
    if (id === '../composables/useInstallationContext.ts') return { useInstallationContext: () => Vue.ref({ mode: 'main', uiScopes: canWrite ? ['chat:write'] : [] }) }
    if (id === '../composables/useLiveClient.ts') return {
      liveProjectId: (base: string) => new URL(base).pathname.split('/').at(-1),
      useLiveClientPool: () => pool,
    }
    if (id === '../composables/useProjectLiveState.ts') return { useProjectLiveState: () => liveState }
    if (id === '../live-refresh.ts') return {
      createLiveRefresh: (options: Parameters<typeof createLiveRefresh>[0]) => createLiveRefresh({ ...options, delayMs: 0 }),
    }
    return require(id)
  }, module, module.exports, new EventTarget(), new EventTarget())
  module.exports.default.render = () => null
  const renderer = Vue.createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}), insert() {}, remove() {},
    setText() {}, setElementText() {}, patchProp() {}, parentNode: () => null, nextSibling: () => null,
  })
  function mount(projectId: string, sessionId = root) {
    const navigation: string[] = []
    const props = Vue.reactive({ apiBase: `http://fixture/projects/${projectId}`, projectId, managed: true, sessionId, visible: true })
    let instance: Vue.ComponentPublicInstance | null = null
    const app = renderer.createApp(Vue.defineComponent({
      setup: () => () => Vue.h(module.exports.default, { ...props, onNavigate: (id: string) => navigation.push(id), ref: (value: Vue.ComponentPublicInstance | null) => { instance = value } }),
    }))
    app.mount({})
    let mounted = true
    const unmount = () => { if (mounted) { mounted = false; app.unmount() } }
    t.after(unmount)
    const state = () => { assert.ok(instance); return Reflect.get(instance.$, 'setupState') }
    state().messages = [{ role: 'assistant', content: '', event: 'tool_call', toolCallId: 'spawn', toolCall: {
      name: 'subagent', arguments: { mode: 'task', description: 'Delegated task' },
    } }]
    state().inputText = 'Keep this exact unsent draft'
    return { props, state, unmount, navigation }
  }
  const invalidate = (projectId: string) => {
    for (const subscription of subscriptions) if (!subscription.closed && subscription.projectId === projectId) subscription.observer.reset('subscription')
  }
  return { mount, invalidate, requests, subscriptions }
}

test('main composer answers the pending question, retains rejected drafts and never sends them as ordinary chat', async t => {
  const f = fixture(t, true)
  const view = f.mount('a')
  const state = view.state()
  state.sessionStages = { [root]: 'waiting' }
  const request = { kind: 'input', id: 'composer-input', sessionId: root, question: 'Which path?',
    recipient: { kind: 'user', sessionId: root }, origin: { physicalId: 'root-0' },
    createdAt: new Date().toISOString(), deadline: null }
  state.handleYieldRequest(request)
  assert.equal(state.answeringQuestion, true)
  const answers: unknown[][] = []
  state.yieldQuestion = { submitCustom: async (...args: unknown[]) => { answers.push(args); return false } }
  state.inputText = '/literal answer, not a slash command'
  await state.sendMessage()
  assert.deepEqual(answers, [[request.id, '/literal answer, not a slash command', []]])
  assert.equal(state.inputText, '/literal answer, not a slash command')
  assert.equal(f.requests.length, 0, 'Answering must not call chat/send')
  state.handleYieldRequest({ ...request, recipient: { kind: 'parent', sessionId: 'web:parent' } })
  assert.equal(state.answeringQuestion, false)
  state.handleYieldRequest(request)
  state.resetConversation()
  assert.equal(state.activeAsk, null)
})

test('composer attachment-only answers upload once and preserve the attachment after a rejected reply', async t => {
  const f = fixture(t, true)
  const state = f.mount('a').state()
  state.sessionStages = { [root]: 'waiting' }
  const request = { kind: 'input', id: 'attachment-answer', sessionId: root, question: 'Send the file',
    recipient: { kind: 'user', sessionId: root }, origin: { physicalId: 'root-0' },
    createdAt: new Date().toISOString(), deadline: null }
  state.handleYieldRequest(request)
  const answers: unknown[][] = []
  state.yieldQuestion = { submitCustom: async (...args: unknown[]) => { answers.push(args); return false } }
  state.inputText = ''
  state.pendingAttachments = [{ key: 'file', file: new File(['Exact attachment'], 'notes.txt'), kind: 'file' }]
  const sending = state.sendMessage()
  await settle()
  assert.match(f.requests[0].path, /api\/chat\/upload$/)
  assert.equal(state.submittingMessage, true)
  f.requests[0].finish({ path: 'C:\\fixture\\uploads\\notes.txt' })
  await sending
  assert.deepEqual(answers, [[request.id, 'See attached files.', ['C:\\fixture\\uploads\\notes.txt']]])
  assert.equal(state.pendingAttachments.length, 1)
  assert.equal(state.submittingMessage, false)
  assert.equal(f.requests.filter(request => request.path.endsWith('/upload')).length, 1)
  assert.equal(f.requests.some(request => request.path.endsWith('/send')), false)
})

test('background response origin survives live boundaries and restoration; legacy replies remain expanded', async t => {
  const f = fixture(t)
  const view = f.mount('a')
  const state = view.state()
  state.messages = []
  const context = createResponseContext('turn', { kind: 'session', sessionId: 'web:peer' }, 'session', 'web')!
  const stream = { accumulated: '' }
  state.applyStreamPayload({ event: 'response', content: 'Partial', responseContext: context }, stream)
  assert.deepEqual(state.streamResponseContext, context)
  assert(isBackgroundResponse(state.streamResponseContext))
  assert.equal(state.expandedResponses.size, 0)
  state.setResponseExpanded(context, true)
  state.applyStreamPayload({ event: 'response', content: ' reply', media: ['result.txt'], responseContext: context }, stream)
  state.applyStreamPayload({ event: 'tool_call', toolCall: { name: 'read', arguments: {} }, toolCallId: 'read' }, stream)
  assert.equal(state.messages[0].content, 'Partial reply')
  assert.deepEqual(state.messages[0].responseContext, context)
  assert.deepEqual(state.messages[0].media, ['result.txt'])
  const next: ResponseContext = { ...context, responseId: 'turn:1', userInvolved: true }
  state.applyStreamPayload({ event: 'response', content: 'User answer', done: true, responseContext: next }, stream)
  assert(!isBackgroundResponse(state.messages.at(-1).responseContext))
  assert.equal(state.streamResponseContext, undefined)
  assert.deepEqual(state.streamMedia, [])
  const history = [
    { role: 'assistant', content: 'Partial reply\nMEDIA:result.txt', responseContext: context },
    { role: 'assistant', content: 'User answer', responseContext: next },
    { role: 'assistant', content: 'Older event reply with no provenance' },
  ]
  state.messages = state.collapseHistory(history)
  assert.deepEqual(state.messages.map((message: { responseContext?: ResponseContext }) => isBackgroundResponse(message.responseContext)), [true, false, false])
  assert(state.expandedResponses.has(context.responseId), 'Refresh must preserve an explicitly opened response')
  assert.equal(state.inputText, 'Keep this exact unsent draft')
  view.props.sessionId = 'web:another'
  await Vue.nextTick()
  assert.equal(state.expandedResponses.size, 0)
})

test('media-only background responses and invalid display metadata never lose the body or attachments', async t => {
  const f = fixture(t)
  const state = f.mount('a').state()
  state.messages = []
  const context = createResponseContext('turn', { kind: 'event', eventId: 'event', type: 'tick', source: 'system' }, 'session', 'web')!
  state.applyStreamPayload({ event: 'response', media: ['image.png'], done: true, responseContext: context }, { accumulated: '' })
  assert.deepEqual(state.messages[0].media, ['image.png'])
  assert(isBackgroundResponse(state.messages[0].responseContext))
  const warnings = t.mock.method(console, 'warn', () => {})
  state.applyStreamPayload({ event: 'response', content: 'Keep this response', done: true,
    responseContext: { ...context, userInvolved: 'false' } }, { accumulated: '' })
  assert.equal(state.messages[1].content, 'Keep this response')
  assert(!isBackgroundResponse(state.messages[1].responseContext))
  assert.equal(warnings.mock.calls.length, 1)
  state.applyStreamPayload({ event: 'response', content: '', done: true, responseContext: context }, { accumulated: '' })
  assert.equal(state.messages.length, 2, 'An empty final does not create an empty disclosure')
})

test('chat keeps outgoing message actions outside generic tools and routes recipient navigation through the current pane', async t => {
  const f = fixture(t)
  const view = f.mount('a')
  view.state().messages = [
    { role: 'assistant', event: 'tool_call', content: '', toolCallId: 'message-1',
      toolCall: { name: 'message', arguments: { sessionId: 'web:peer', content: 'Review this' } } },
    { role: 'tool', event: 'tool_result', toolCallId: 'message-1', content: 'Message sent to web:peer. Queued.' },
    { role: 'assistant', event: 'tool_call', content: '', toolCallId: 'read-1',
      toolCall: { name: 'read', arguments: { path: 'file.ts' } } },
  ]
  await Vue.nextTick()
  assert.equal(view.state().messageActions.entries.get(0).sessionId, 'web:peer')
  assert.equal(view.state().messageActions.entries.get(0).status, 'queued')
  assert.deepEqual([...view.state().toolActivity.keys()], [2])
  view.state().inspectExecution('web:peer')
  assert.deepEqual(view.navigation, ['web:peer'])
  assert.equal(view.state().inputText, 'Keep this exact unsent draft')
})

test('live and restored tool images stay attached to the tool result rather than becoming user messages', async t => {
  const f = fixture(t)
  const view = f.mount('a')
  const state = view.state()
  const image = 'data:image/png;base64,aW1hZ2U='
  const call = { id: 'image-read', type: 'function', function: { name: 'read', arguments: '{"path":"image.png"}' } }
  const raw = [
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', name: 'read', tool_call_id: call.id, content: [
      { type: 'text', text: 'Image from image.png' }, { type: 'image_url', image_url: { url: image } },
    ] },
  ]
  const restored = state.collapseHistory(raw)
  assert.equal(restored.length, 2)
  assert.equal(restored[1].event, 'tool_result')
  assert.equal(restored[1].toolCallId, call.id)
  assert.deepEqual(restored[1].media, [image])
  assert(!restored.some((message: { role: string }) => message.role === 'user'))
  state.messages = []
  state.applyStreamPayload({ event: 'tool_call', content: 'read', toolCallId: call.id, toolCall: { name: 'read', arguments: { path: 'image.png' } } }, { accumulated: '' })
  state.applyStreamPayload({ event: 'tool_result', content: 'Image from image.png', toolCallId: call.id, media: [image] }, { accumulated: '' })
  await Vue.nextTick()
  assert.deepEqual(state.toolActivity.get(0).entries[0].images, [image])
})

test('image preview survives message updates but closes when its conversation or pane is no longer visible', async t => {
  const f = fixture(t)
  const view = f.mount('a')
  const image = { src: 'https://example.invalid/image.png', name: 'Screenshot' }
  view.state().openImagePreview(image)
  view.state().messages = [...view.state().messages, { role: 'assistant', content: 'More content' }]
  await Vue.nextTick()
  assert.equal(view.state().imagePreview.src, image.src)
  view.props.visible = false
  await Vue.nextTick()
  assert.equal(view.state().imagePreview, undefined)
  view.props.visible = true
  await Vue.nextTick()
  view.state().openImagePreview(image)
  view.state().viewingPhysicalId = 'older-segment'
  await Vue.nextTick()
  assert.equal(view.state().imagePreview, undefined)
  view.state().openImagePreview(image)
  view.state().activePanel = 'diagnosis'
  await Vue.nextTick()
  assert.equal(view.state().imagePreview, undefined)
  view.state().openImagePreview(image)
  view.props.sessionId = task
  await Vue.nextTick()
  assert.equal(view.state().imagePreview, undefined)
  assert.equal(view.state().inputText, 'Keep this exact unsent draft')
})

test('sessions invalidation refreshes mounted chat graph and metadata-only call waits without reloading or crossing projects', async t => {
  const f = fixture(t)
  const a = f.mount('a')
  const b = f.mount('b')
  f.invalidate('a')
  f.invalidate('b')
  await settle()
  assert.equal(f.requests.length, 4)
  for (const request of f.requests) request.finish(request.path.endsWith('/graph') ? graph()
    : { stages: { [root]: 'idle', [task]: 'waiting' }, waitingForCalls: { [task]: false } })
  await settle()
  const stage = (view: typeof a) => sessionActivity(view.state().inlineExecutions.entries.get(0).stage).label
  assert.equal(stage(a), 'Waiting for a response')
  assert.equal(stage(b), 'Waiting for a response')
  f.invalidate('a')
  await settle()
  assert.equal(f.requests.length, 6)
  assert.match(f.requests[4].path, /^\/projects\/a\/api\/sessions\/graph$/)
  f.requests[4].finish(graph())
  await settle()
  f.requests[5].finish({ stages: { [root]: 'idle', [task]: 'waiting' }, waitingForCalls: { [task]: true } })
  await settle()
  assert.equal(stage(a), 'Waiting for call', 'The same mounted reducer observes a metadata-only change')
  assert.equal(stage(b), 'Waiting for a response')
  assert.equal(a.state().inputText, 'Keep this exact unsent draft')
  const poll = a.state().refreshSessionActivity()
  await settle()
  f.requests[6].finish({ stages: { [root]: 'idle', [task]: 'waiting' }, waitingForCalls: { [task]: false } })
  await poll
  assert.equal(stage(a), 'Waiting for a response', 'Clearing call-wait metadata cannot retain a stale graph flag')
  f.invalidate('a')
  await settle()
  a.props.projectId = 'c'
  a.props.apiBase = 'http://fixture/projects/c'
  await Vue.nextTick()
  assert.equal(f.requests[7].signal.aborted, true)
  assert.equal(f.subscriptions[0].closed, true)
  const stale = graph()
  stale.sessions[1]!.waitingForCall = true
  f.requests[7].finish(stale)
  await settle()
  assert.equal(stage(a), 'Waiting for a response')
  f.requests[9].finish(graph())
  await settle()
  const state = a.state()
  a.unmount()
  assert.equal(f.requests[10].signal.aborted, true)
  f.requests[10].finish({ stages: { [task]: 'waiting' }, waitingForCalls: { [task]: true } })
  await settle()
  assert.equal(state.allSessions.find((session: { sessionId: string }) => session.sessionId === task).waitingForCall, false)
  b.props.visible = false
  await Vue.nextTick()
  assert.ok(f.subscriptions.every(subscription => subscription.closed))
})

test('coordinator uses the ordinary writable chat and SSE-discovered topics navigate independently', async t => {
  const f = fixture(t)
  const a = f.mount('a', 'web:orchestrator')
  const b = f.mount('b', 'web:orchestrator')
  assert.equal(f.requests.length, 0, 'Mounting a coordinator does not ensure or send a turn')
  assert.equal(a.state().isDirectChat, true)
  f.invalidate('a')
  await settle()
  f.requests[0]!.finish({ nodes: [], sessions: [
    { sessionId: 'web:orchestrator', sessionKind: 'orchestrator', mode: 'session', parentSessionId: null },
    { sessionId: 'web:chat-topic', sessionKind: 'topic', mode: 'session', parentSessionId: null,
      createdBySessionId: 'web:orchestrator', topic: { title: 'Installer', goal: 'Ship', scope: 'Windows' } },
  ] })
  await settle()
  f.requests[1]!.finish({ stages: {} })
  await settle()
  assert.equal(a.state().allSessions[1].label, 'Installer')
  assert.equal(b.state().allSessions.length, 0, 'Same coordinator ID never shares Project graph state')
  a.state().requestSession('web:chat-topic')
  assert.deepEqual(a.navigation, ['web:chat-topic'])
  assert.equal(a.state().inputText, 'Keep this exact unsent draft')
  assert.equal(f.requests.some(request => /orchestrator$/.test(request.path)), false)
})

test('live peer messages render like persisted history without becoming human prompts or assistant output', async t => {
  const f = fixture(t)
  const view = f.mount('a')
  for (const intent of ['progress', 'request', 'question', 'handoff', 'acknowledgement']) {
    const message = {
      role: 'user', timestamp: '2026-09-20T00:00:00Z',
      content: [
        { type: 'text', text: `<sender id="web:peer" name="A &amp; B" source="session" intent="${intent}" />` },
        { type: 'text', text: '**Initial** peer message' },
      ],
    }
    const payload = { event: 'session_message', message, media: ['media:fixture.png'] }
    const state = view.state()
    assert.equal(state.isStreamPayload(payload), true)
    state.messages = []
    const stream = { accumulated: 'Existing assistant output', timestamp: '2026-09-19T23:59:00Z' }
    assert.equal(state.applyStreamPayload(payload, stream), false)
    const [assistant, peer] = state.messages
    assert.equal(assistant.content, 'Existing assistant output')
    assert.equal(peer.role, 'user')
    assert.equal(peer.content, '**Initial** peer message')
    assert.deepEqual(peer.sessionSource, { id: 'web:peer', name: 'A & B', intent })
    assert.equal(peer.isSystemEvent, undefined)
    assert.deepEqual(peer.media, ['media:fixture.png'])
    assert.deepEqual(state.historyMarkers, [])
    assert.equal(state.canResend, false)
    assert.equal(stream.accumulated, '')
    const restored = state.collapseHistory([message])[0]
    assert.equal(restored.content, peer.content)
    assert.deepEqual(restored.sessionSource, peer.sessionSource)
    assert.equal(restored.timestamp, peer.timestamp)
  }
  assert.equal(view.state().isStreamPayload({ event: 'session_message', message: { role: 'assistant', content: 'Not an envelope' } }), false)
})

test('history navigation cancels queued bottom jumps and resumes following only after returning to the bottom', async t => {
  const state = fixture(t).mount('a').state()
  const container = { scrollTop: 1500, scrollHeight: 2000, clientHeight: 500 }
  state.messagesContainer = container
  state.scrollToBottom()
  state.browseHistory()
  state.trackHistoryScroll()
  await Vue.nextTick()
  assert.equal(container.scrollTop, 1500, 'The initial bottom position cannot cancel a smooth history jump')
  container.scrollTop = 100
  state.trackHistoryScroll()
  state.scrollToBottom()
  await Vue.nextTick()
  assert.equal(container.scrollTop, 100, 'New output and refreshed history must not pull the reader away')
  container.scrollTop = 1500
  state.trackHistoryScroll()
  state.scrollToBottom()
  await Vue.nextTick()
  assert.equal(container.scrollTop, 2000)
})

test('composer file drops preserve drafts, deduplicate mixed batches and reject remote or read-only attachments', async t => {
  const f = fixture(t)
  const state = f.mount('a').state()
  state.currentWorkdir = { kind: 'local', displayPath: 'C:\\synthetic' }
  const files = [
    new File(['notes'], 'notes.txt', { type: 'text/plain', lastModified: 1 }),
    new File(['image'], 'photo.png', { type: 'image/png', lastModified: 2 }),
  ]
  let prevented = 0
  const event = { dataTransfer: { types: ['Files'], files, dropEffect: 'none' },
    preventDefault: () => { prevented++ }, stopPropagation: () => {} }
  state.handleAttachmentDragOver(event)
  assert.equal(state.attachmentDropTarget, true)
  assert.equal(event.dataTransfer.dropEffect, 'copy')
  state.handleAttachmentDrop(event)
  state.handleAttachmentDrop(event)
  assert.equal(prevented, 3)
  assert.equal(state.attachmentDropTarget, false)
  assert.deepEqual(state.pendingAttachments.map((item: { file: File; kind: string }) => [item.file.name, item.kind]),
    [['notes.txt', 'file'], ['photo.png', 'image']])
  assert.equal(state.inputText, 'Keep this exact unsent draft')
  assert.equal(f.requests.length, 0, 'A drop must not upload or send')
  await Vue.nextTick()
  const image = state.pendingAttachments[1]
  state.openImagePreview({src: image.previewUrl, name: image.file.name})
  state.clearPendingAttachments()
  await Vue.nextTick()
  assert.equal(state.imagePreview, undefined, 'Removing draft attachments closes previews before their blob URLs can remain stale')
  for (const mode of ['remote', 'readonly']) {
    state.currentWorkdir = { kind: mode === 'remote' ? 'remote' : 'local', displayPath: 'C:\\synthetic' }
    state.selectedMode = mode === 'readonly' ? 'task' : 'session'
    state.handleAttachmentDragOver(event)
    assert.equal(state.attachmentDropTarget, false)
    assert.equal(event.dataTransfer.dropEffect, 'none')
    state.handleAttachmentDrop(event)
    assert.equal(state.pendingAttachments.length, 0)
    assert.match(state.composerError, mode === 'remote' ? /remote workspaces/ : /cannot receive file attachments/)
  }
})
