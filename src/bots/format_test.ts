import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseBot, botInferenceSettings, validateBotInference } from './sdk.ts'
import { migrateBotFrontmatter } from './format.ts'
import { botFiles } from './sdk-test-fixture.ts'
import { freeze } from './deployments.ts'
import type { ModelInfo } from '../providers/provider.ts'

const inference = { model: 'chosen@fixture', temperature: 0, maxTokens: 321, thinking: { type: 'enabled' }, reasoningEffort: 'high' }
const personal = { mode: 'personal', connection: '11111111-1111-4111-8111-111111111111', agent: 'general', tools: [] }
const modern = (overrides: Record<string, unknown> = {}) => migrateBotFrontmatter(botFiles('', overrides))
const setConfig = (files: Record<string, string>, patch: Record<string, unknown>) => ({ ...files, 'bot.json': JSON.stringify({ ...JSON.parse(files['bot.json']!), ...patch }) })

test('whole legacy and new Service/Personal formats normalize identically without source evaluation', () => {
  for (const overrides of [inference, personal]) {
    const legacy = botFiles('throw new Error("DO NOT EXECUTE")', overrides)
    const original = structuredClone(legacy), converted = migrateBotFrontmatter(legacy)
    assert.deepEqual(parseBot(converted), parseBot(legacy))
    assert.deepEqual(legacy, original)
    assert.deepEqual(migrateBotFrontmatter(converted), converted, 'idempotent, byte-identical on new format')
    assert.notEqual(freeze(legacy).revision, freeze(converted).revision)
    assert.equal(converted['tools/main.ts'], legacy['tools/main.ts'])
    const config = JSON.parse(converted['bot.json']!)
    for (const key of ['mode', 'agent', ...Object.keys(inference)]) assert.equal(Object.hasOwn(config, key), false)
    if (overrides === personal) assert.equal(config.connection, personal.connection)
    assert.equal(config.subscriptions, undefined, 'do not materialize omitted subscriptions')
    assert.equal(config.bindings.length, 0)
  }
})

test('duplicate values and partially split formats fail closed, never use precedence', () => {
  for (const [key, value] of Object.entries({ mode: 'service', ...inference })) {
    assert.throws(() => parseBot(setConfig(modern(inference), { [key]: value })), /duplicate or mixed/)
    assert.throws(() => parseBot(setConfig(modern(), { [key]: value })), /duplicate or mixed/)
  }
  assert.throws(() => parseBot(setConfig(modern(personal), { agent: 'general' })), /duplicate or mixed/)
  assert.throws(() => parseBot(setConfig(modern(personal), { mode: 'personal' })), /duplicate or mixed/)
  const legacy = botFiles()
  for (const line of ['model: chosen', 'agent: general', 'temperature: 0'])
    assert.throws(() => parseBot({ ...legacy, 'BOT.md': legacy['BOT.md']!.replace('config: bot.json', `config: bot.json\n${line}`) }))
  for (const fields of ['connection: 11111111-1111-4111-8111-111111111111', 'tools: []', 'subscriptions: []', 'bindings: []', 'skills: []', 'allowedModules: []', 'sourceFolders: []', 'readDomains: []', 'discordHistory: {}']) {
    const files = modern()
    assert.throws(() => parseBot({ ...files, 'BOT.md': files['BOT.md']!.replace('mode: service', `mode: service\n${fields}`) }))
  }
  assert.throws(() => parseBot(setConfig(modern(), { id: 'other' })), /identity/)
  assert.throws(() => parseBot(setConfig(modern(), { prompt: 'other' })), /identity/)
})

test('strict mode-specific header types and duplicate YAML keys', () => {
  for (const extra of ['agent: general', 'model: null', 'temperature: 3', 'maxTokens: 1.5', 'thinking: {type: adaptive}', 'reasoningEffort: extreme', 'mode: personal']) {
    const files = modern()
    assert.throws(() => parseBot({ ...files, 'BOT.md': files['BOT.md']!.replace('mode: service', `mode: service\n${extra}`) }))
  }
  for (const extra of ['model: chosen', 'temperature: 0', 'maxTokens: 10', 'thinking: {type: enabled}', 'reasoningEffort: high']) {
    const files = modern(personal)
    assert.throws(() => parseBot({ ...files, 'BOT.md': files['BOT.md']!.replace('agent: general', `agent: general\n${extra}`) }))
  }
  const files = modern(personal)
  assert.throws(() => parseBot({ ...files, 'BOT.md': files['BOT.md']!.replace('agent: general\n', '') }))
  assert.throws(() => parseBot(setConfig(modern(), { connection: personal.connection })))
  assert.throws(() => parseBot(setConfig(files, { connection: undefined })))
})

test('custom config path, CRLF prompt bytes, zero values and explicit empty subscriptions survive conversion', () => {
  const files = botFiles('', { ...inference, subscriptions: [], bindings: [{ platform: 'qq', botInstanceId: 'connection', conversationId: 'group:one', tools: [], allowFrom: [], trigger: 'all' }] })
  files['nested/settings.json'] = files['bot.json']!.replace(/\n/g, '\r\n'); delete files['bot.json']
  files['BOT.md'] = files['BOT.md']!.replace('bot.json', 'nested/settings.json').replace(/\n/g, '\r\n') + '\r\n\r\nVerbatim prompt.  \r\n'
  const next = migrateBotFrontmatter(files)
  assert.equal(next['BOT.md']!.split('---\r\n')[2], files['BOT.md']!.split('---\r\n')[2])
  assert.deepEqual(JSON.parse(next['nested/settings.json']!).bindings, JSON.parse(files['nested/settings.json']!).bindings)
  assert.deepEqual(parseBot(next), parseBot(files))
  assert.equal(parseBot(next).subscriptions?.length, 0)
  assert.equal(botInferenceSettings(parseBot(next)).temperature, 0)
})

test('QQ, Feishu and Discord get the same Bot-wide settings and provider capability validation', () => {
  const bindings = [
    { platform: 'qq', botInstanceId: 'bot', conversationId: 'group:one', tools: [] },
    { platform: 'feishu', botInstanceId: 'bot', conversationId: 'oc_one', tools: [] },
    { platform: 'discord', id: '11111111-1111-4111-8111-111111111111', botInstanceId: 'bot', botUserId: '123', target: { kind: 'channel', guildId: '123', channelId: '456' }, enabled: true, trigger: 'mention', participants: { everyone: true, userIds: [], roleIds: [] }, tools: [], readDomains: [], inheritThreads: false, manage: false },
  ]
  for (const binding of bindings) {
    const bot = parseBot(modern({ ...inference, bindings: [binding] }))
    assert.deepEqual(botInferenceSettings(bot), inference)
    const defaults = { model: 'default@fixture', temperature: 0.8, contextWindow: 128000 }
    const models: ModelInfo[] = [{ id: 'chosen@fixture', name: 'Chosen', reasoningEfforts: ['high'] }]
    assert.doesNotThrow(() => validateBotInference(bot, defaults, models, id => id))
    assert.throws(() => validateBotInference(bot, defaults, [{ id: 'chosen@fixture', name: 'Chosen', reasoningEfforts: ['low'] }], id => id))
  }
  assert.deepEqual(botInferenceSettings(parseBot(modern(personal))), {})
})
