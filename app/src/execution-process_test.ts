import assert from 'node:assert/strict'
import test from 'node:test'
import { groupToolActivity, isProcessMessage, type ToolActivityMessage } from './tool-activity.ts'

const thinking = (text: string): ToolActivityMessage => ({ role: 'assistant', content: '', reasoningText: text })
const call: ToolActivityMessage = { role: 'assistant', event: 'tool_call', content: '', toolCallId: 'read-1', toolCall: { name: 'read', arguments: { path: 'a.ts' } } }
const result: ToolActivityMessage = { event: 'tool_result', content: 'File contents', toolCallId: 'read-1' }

test('execution process preserves real reasoning order and per-round usage, including literal status-like text', () => {
  const usage = { promptTokens: 20, completionTokens: 3, totalTokens: 23 }
  const groups = groupToolActivity([thinking('思考中'), call, result, { ...thinking('Next reasoning'), usage }, { role: 'assistant', content: 'User-facing answer' }])
  assert.equal(groups.size, 1)
  const batch = groups.get(0)!
  assert.equal(batch.end, 4)
  assert.deepEqual(batch.entries.map(entry => entry.index), [0, 1, 3])
  assert.equal(batch.entries[0].reasoning, '思考中')
  assert.equal(batch.entries[1].result, 'File contents')
  assert.equal(batch.entries[2].reasoning, 'Next reasoning')
  assert.deepEqual(batch.entries[2].usage, usage)
})

test('prose, attachments, events, summaries, errors, receipts and session messages remain hard boundaries', () => {
  const boundaries: ToolActivityMessage[] = [
    { role: 'assistant', content: 'Answer', reasoningText: 'Private reasoning' },
    { role: 'assistant', content: '', media: ['image.png'], reasoningText: 'Image reasoning' },
    { ...thinking('event'), event: 'notification' },
    { ...thinking('summary'), isSummary: true },
    { ...thinking('error'), isError: true },
    { ...thinking('receipt'), commandReceipt: {} },
    { ...thinking('session message'), sessionSource: {} },
    { role: 'user', content: '', reasoningText: 'User content' },
  ]
  for (const boundary of boundaries) {
    assert.equal(isProcessMessage(boundary), false)
    assert.equal(groupToolActivity([thinking('before'), boundary, thinking('after')]).size, 2)
  }
})

test('interactive exclusions and after-cards split the process without changing original indices', () => {
  const groups = groupToolActivity([thinking('before'), call, result, thinking('after')], new Set([1, 2]))
  assert.deepEqual([...groups.keys()], [0, 3])
  const afterCardGroups = groupToolActivity([thinking('first'), thinking('second')], new Set(), new Set([0]))
  assert.deepEqual([...afterCardGroups.keys()], [0, 1])
})

test('legacy tool pairing survives intervening reasoning but not prose', () => {
  const legacy = { ...call, toolCallId: undefined }
  const legacyResult = { ...result, toolCallId: undefined }
  assert.equal(groupToolActivity([legacy, thinking('reasoning'), legacyResult]).get(0)!.entries[0].result, 'File contents')
  assert.equal(groupToolActivity([legacy, { content: 'prose' }, legacyResult]).get(0)!.entries[0].result, undefined)
})

test('actual ChatTab message template emits no empty assistant article and keeps prose and usage details', async () => {
  const { readFile } = await import('node:fs/promises')
  const { createRequire } = await import('node:module')
  const { compileTemplate, parse } = await import('vue/compiler-sfc')
  const { createSSRApp, defineComponent, h } = await import('vue')
  const { renderToString } = await import('vue/server-renderer')
  const ts = (await import('typescript')).default
  const source = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const template = parse(source).descriptor.template!.content
  const start = template.indexOf('<template v-for="(msg, idx) in displayMessages"')
  const end = template.indexOf('</component>', start) + '</component>'.length
  const rowTemplate = template.slice(start, end) + '</template>'
  assert.ok(start >= 0 && end > start)
  const compiled = compileTemplate({ source: `<div>${rowTemplate}</div></template></div>`, filename: 'ChatProcessRows.vue', id: 'process', ssr: true, ssrCssVars: [] })
  assert.deepEqual(compiled.errors, [])
  const module = { exports: {} as { ssrRender?: unknown } }
  const code = ts.transpileModule(compiled.code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText
  new Function('require', 'module', 'exports', code)(createRequire(import.meta.url), module, module.exports)
  const displayMessages = [
    { role: 'assistant', content: '' },
    thinking('思考中'), call, result,
    { role: 'assistant', reasoningText: 'Reason before answer', content: 'Final answer', usage: { promptTokens: 5, completionTokens: 2, totalTokens: 7 } },
    { role: 'user', content: 'Next user turn' },
    { role: 'assistant', content: '', usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 } },
    { role: 'assistant', content: '', reasoningText: '  \n\t', usage: { promptTokens: 8, completionTokens: 1, totalTokens: 9 } },
  ].map(message => ({ ...message, attachmentBody: { text: message.content, paths: [] } }))
  const emptyEntries = { entries: new Map(), after: new Map() }
  const Root = defineComponent({
    setup: () => ({
      displayMessages, messages: displayMessages, toolActivity: groupToolActivity(displayMessages),
      activeSessionId: 'owner', viewingPhysicalId: null, apiBase: '', activePanel: 'conversation',
      automationConversation: null, inlineExecutions: emptyEntries, messageActions: emptyEntries,
      ioAfter: new Map(), inputQuestions: emptyEntries, yieldDecisions: emptyEntries, installation: { uiScopes: [] },
      streaming: false, streamContent: '', isDirectChat: true, requestBusy: false, currentRecovery: null,
      expandedThinking: new Set(), currentWorkdir: undefined, childSessionId: null,
      t: (key: string) => key, formatNumber: String, renderMarkdown: (text: string) => `<p>${text}</p>`,
      isErrorMessage: () => false, clearSelection() {}, setThinkingExpanded() {}, inspectExecution() {}, openImagePreview() {},
    }),
    ssrRender: module.exports.ssrRender as never,
  })
  const app = createSSRApp(Root)
  app.directive('answer-html', {})
  const Stub = defineComponent({ render: () => null })
  for (const name of ['AutomationPayload', 'CommandResult', 'ExecutionMessage', 'MessageAction', 'InputQuestion', 'YieldDecision', 'ConversationEvent', 'ConversationSummary', 'SessionMessageDisclosure', 'MessageAttachments', 'MessageTimestamp']) app.component(name, Stub)
  app.component('ReasoningItem', defineComponent({ props: ['text', 'open'], setup: props => () => h('details', { class: 'reasoning-item', open: props.open }, [h('summary', 'Thinking'), props.open ? h('div', props.text) : null]) }))
  app.component('ToolActivityGroup', defineComponent({ props: ['batch'], setup: props => () => h('section', { class: 'process-fixture' }, props.batch.entries.map((entry: { index: number; reasoning?: string }) => h('span', { 'data-msg-idx': entry.index }, entry.reasoning ?? 'tool'))) }))
  const html = await renderToString(app)
  assert.equal((html.match(/role="article"/g) ?? []).length, 2, 'Only actual assistant answer and user prose produce articles')
  assert.match(html, /思考中/)
  assert.match(html, /data-msg-idx="1"/)
  assert.match(html, /Final answer/)
  assert.ok(html.indexOf('class="reasoning-item"') < html.indexOf('data-msg-idx="4"'), 'Reasoning precedes the answer card')
  assert.match(html, /<details class="reasoning-item">/)
  assert.doesNotMatch(html, /Reason before answer/)
  assert.doesNotMatch(html, /thinking-block/)
  assert.match(html, /Next user turn/)
  assert.match(html, /<div class="usage-info">/)
  assert.doesNotMatch(html, /usage-details/)
  assert.doesNotMatch(source, /role="status">\{\{ t\('Thinking'\) \}\}/)
  assert.doesNotMatch(html, /usage-delta/)
  for (const index of [0, 6, 7]) assert.doesNotMatch(html, new RegExp('data-search-message-idx="' + index + '"'), 'Empty/usage-only messages have no wrapper or spacing')
})

test('usage-only and whitespace-only reasoning history has no visible process group', () => {
  const usage = { promptTokens: 10, completionTokens: 2, totalTokens: 12 }
  assert.equal(groupToolActivity([{ role: 'assistant', content: '', usage }, { ...thinking('  \n\t'), usage }]).size, 0)
  const mixed = groupToolActivity([{ role: 'assistant', content: '', usage }, call, result]).get(0)!
  assert.equal(mixed.entries.length, 1)
  assert.deepEqual(mixed.usages, [{ index: 0, usage }])
  const original = '  real reasoning\n'
  assert.equal(groupToolActivity([thinking(original)]).get(0)!.entries[0].reasoning, original)
})
