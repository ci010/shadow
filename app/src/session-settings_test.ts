import assert from 'node:assert/strict'
import test from 'node:test'
import { currentEffort, effortOptions, effortOptionsForModel, isChannelConversation, reasoningSettingsForEffort, updateSessionSettings } from './session-settings.ts'
import { parseSessionGraph } from './folders-sidebar.ts'
import { readFile } from 'node:fs/promises'
import { compileScript, compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'

for (const platform of ['qq', 'discord', 'feishu']) test(`${platform} conversation controls keep inherited defaults separate from session overrides and exclude executions`, () => {
  const sessionId = `bot:project-a:bot-a:${platform}:group%3Aa`
  const inferenceDefaults = { model: 'agent-model', thinking: { type: 'enabled' }, reasoningEffort: 'low' }
  const graph = (extra: Record<string, unknown> = {}) => ({ nodes: [], sessions: [
    { sessionId, mode: 'session', config: { model: 'override', reasoningEffort: 'high' }, inferenceDefaults, ...extra },
  ] })
  const session = parseSessionGraph(graph(), 'project-a')[0]!
  assert.equal(isChannelConversation(session), true)
  assert.deepEqual(session.inferenceDefaults, inferenceDefaults)
  assert.equal(session.config?.model, 'override')
  assert.equal(isChannelConversation({ ...session, sessionId: `${platform}:group:legacy`, channelAddress: undefined }), true)
  for (const mode of ['task', 'call'] as const) assert.equal(isChannelConversation({ ...session, mode }), false)
  for (const sessionId of ['web:chat-fixture', 'cron:fixture', 'system:fixture']) assert.equal(isChannelConversation({ sessionId }), false)
  assert.equal(isChannelConversation(undefined), false)
  assert.equal(parseSessionGraph(graph({ inferenceDefaults: null }), 'project-a')[0]!.inferenceDefaults, undefined)
  for (const invalid of [{}, { model: 1 }, { model: 'a', thinking: { type: 'auto' } }, { model: 'a', reasoningEffort: 'extreme' }]) {
    assert.throws(() => parseSessionGraph(graph({ inferenceDefaults: invalid }), 'project-a'))
  }
})

test('unified effort choices update thinking and effort together and represent disabled legacy settings', () => {
  assert.deepEqual(effortOptions.map(option => option.value), ['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(reasoningSettingsForEffort('none'), { thinking: { type: 'disabled' }, reasoningEffort: null })
  assert.deepEqual(reasoningSettingsForEffort('default'), { thinking: null, reasoningEffort: null })
  for (const effort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    assert.deepEqual(reasoningSettingsForEffort(effort), { thinking: { type: 'enabled' }, reasoningEffort: effort })
    assert.equal(currentEffort(reasoningSettingsForEffort(effort)), effort)
  }
  assert.equal(currentEffort({ thinking: { type: 'disabled' }, reasoningEffort: 'max' }), 'none')
  assert.equal(currentEffort({ thinking: { type: 'enabled' } }), 'default')
  assert.equal(currentEffort({}), 'default')
})

test('None and Default submit atomic session patches instead of a literal unsupported none effort', async () => {
  for (const effort of ['none', 'default'] as const) {
    const patch = reasoningSettingsForEffort(effort)
    const result = await updateSessionSettings('http://fixture', 'web:choice', patch, new AbortController().signal, async (_url, init) => {
      assert.deepEqual(JSON.parse(String(init?.body)), patch)
      return Response.json({ key: 'web:choice', config: effort === 'none' ? { thinking: { type: 'disabled' } } : {} })
    })
    assert.equal(currentEffort(result), effort)
    assert.equal(result.reasoningEffort, null)
  }
})

test('model menu and unified effort controls compile and the composer has one settings trigger', async () => {
  for (const filename of ['ModelSelector.vue', 'ReasoningControls.vue']) {
    const source = await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8')
    const { descriptor, errors } = parse(source, { filename })
    assert.deepEqual(errors, [])
    const script = compileScript(descriptor, { id: filename })
    assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename, id: filename,
      compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
    for (const style of descriptor.styles) assert.deepEqual(compileStyle({
      source: style.content, filename, id: filename, scoped: true,
    }).errors, [])
    if (filename === 'ModelSelector.vue') {
      assert.match(source, /model-menu-model/)
      assert.match(source, /model-menu-effort/)
      assert.match(source, /@opened="resetMenu"/)
    } else assert.doesNotMatch(source, /ComposerPopover/)
  }
  const chat = await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  assert.match(chat, /<ModelSelector :settings="reasoningSettings"/)
  assert.doesNotMatch(chat, /<ReasoningControls/)
})

test('reasoning changes update only the selected session and null resets inherited defaults', async () => {
  const signal = new AbortController().signal
  const request: typeof fetch = async (input, init) => {
    assert.equal(input, 'http://main/api/sessions/web%3Achat-one/config')
    assert.equal(init?.method, 'PATCH')
    assert.deepEqual(JSON.parse(String(init?.body)), { thinking: null })
    assert.ok(init?.signal)
    return Response.json({ key: 'web:chat-one', config: { model: 'kept', reasoningEffort: 'high' } })
  }
  assert.deepEqual(await updateSessionSettings('http://main', 'web:chat-one', { thinking: null }, signal, request), {
    model: 'kept', thinking: null, reasoningEffort: 'high',
  })
})

test('settings failures never look like successful updates', async () => {
  for (const response of [
    new Response('denied', { status: 403 }),
    Response.json({ key: 'other', config: {} }),
    Response.json({ key: 'web:chat-one', config: [] }),
    Response.json({ key: 'web:chat-one', config: { thinking: { type: 'unknown' } } }),
    Response.json({ key: 'web:chat-one', config: { reasoningEffort: 'unsupported' } }),
    new Response('<html>old backend</html>'),
  ]) {
    await assert.rejects(updateSessionSettings('http://fixture', 'web:chat-one', { reasoningEffort: 'max' },
      new AbortController().signal, async () => response))
  }
})

test('GPT effort levels survive PATCH responses and refreshed session graphs', async () => {
  for (const reasoningEffort of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
    const config = reasoningSettingsForEffort(reasoningEffort)
    const result = await updateSessionSettings('http://fixture', 'web:gpt', config,
      new AbortController().signal, async (_url, init) => {
        assert.deepEqual(JSON.parse(String(init?.body)), config)
        return Response.json({ key: 'web:gpt', config })
      })
    assert.equal(result.reasoningEffort, reasoningEffort)
    const graph = parseSessionGraph({ sessions: [{ sessionId: 'web:gpt', config }], nodes: [] })
    assert.equal(currentEffort(graph[0].config!), reasoningEffort)
  }
})

test('GPT effort options include every requested level without changing non-GPT menus', () => {
  for (const model of ['gpt-6-astra', 'gpt-6-astra@copilot', 'gpt-5.4@openai', 'openai/gpt-5.4@custom', 'GPT-5']) {
    assert.deepEqual(effortOptionsForModel(model).map(option => option.label),
      ['Default', 'None', 'Low', 'Medium', 'High', 'XHigh', 'Max'])
  }
  for (const model of ['', 'deepseek-flash', 'deepseek-v4-pro@deepseek', 'claude-opus', 'not-gpt-5', 'model@gpt']) {
    assert.deepEqual(effortOptionsForModel(model).map(option => option.value),
      ['default', 'none', 'low', 'high', 'max'])
  }
})


test('context choices PATCH only the selected conversation and retain null inheritance', async () => {
  for (const contextWindow of [256000, 400000, 1000000, null]) {
    const settings = await updateSessionSettings('http://fixture', 'web:context-one', { contextWindow }, new AbortController().signal,
      async (url, options) => {
        assert.match(String(url), /web%3Acontext-one/)
        assert.deepEqual(JSON.parse(String(options?.body)), { contextWindow })
        return Response.json({ key: 'web:context-one', config: contextWindow === null ? {} : { contextWindow } })
      })
    assert.equal(settings.contextWindow, contextWindow ?? undefined)
  }
})
