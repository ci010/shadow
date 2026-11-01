import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBot, defineBot, defineTool, BotDefinitionSchema } from './sdk.ts'

import { botFiles } from './sdk-test-fixture.ts'

test('pure BOT parser, defineBot typed data, defineTool identity', () => {
  const files = botFiles('process.exit(1)')
  const bot = parseBot(files)
  assert.equal(bot.id, 'demo')
  assert.equal(bot.prompt, 'A helpful bot.')
  assert.deepEqual(defineBot(bot), bot)
  assert.equal(defineTool({ execute: () => 1 }).execute({}, {} as never), 1)
})

test('reject invalid schema, policy escalation, duplicate names and package bounds', () => {
  const bot = parseBot(botFiles())
  assert.equal(BotDefinitionSchema.safeParse({ ...bot, tools: [...bot.tools, ...bot.tools] }).success, false)
  assert.equal(BotDefinitionSchema.safeParse({ ...bot, tools: [{ ...bot.tools[0], imports: ['@shadow/fetch'] }] }).success, false)
  assert.equal(BotDefinitionSchema.safeParse({ ...bot, allowedModules: ['node:fs'] }).success, false)
  assert.equal(BotDefinitionSchema.safeParse({ ...bot, tools: [{ ...bot.tools[0], parameters: { $ref: 'file:///etc/passwd' } }] }).success, false)
  assert.throws(() => parseBot({ ...botFiles(), '../escape.ts': '' }))
  assert.throws(() => parseBot({ ...botFiles(), 'large.ts': 'a'.repeat(512_001) }))
  assert.throws(() => parseBot({ ...botFiles(), 'BOT.md': '---\nid: demo\nconfig: ../outside.json\n---\nprompt' }))
  assert.throws(() => parseBot(botFiles('', { id: 'override' })))
  assert.throws(() => parseBot({ ...botFiles(), 'BOT.md': '---\nid: demo\nid: evil\nconfig: bot.json\n---\nprompt' }))
})

test('QQ and Discord bindings accept explicit validated custom names, no legacy agent fields', () => {
  const files = botFiles('', { bindings: [{ platform: 'qq', botInstanceId: 'bot', conversationId: 'chat', tools: ['custom_tool'] }, {
    platform: 'discord', id: '11111111-1111-4111-8111-111111111111', botInstanceId: 'bot', botUserId: '123', target: { kind: 'channel', guildId: '123', channelId: '456' }, enabled: true, trigger: 'mention', participants: { everyone: true, userIds: [], roleIds: [] }, tools: ['custom_tool'], readDomains: [], inheritThreads: false, manage: false,
  }] })
  assert.equal(parseBot(files).bindings.length, 2)
  assert.throws(() => parseBot(botFiles('', { bindings: [{ platform: 'qq', botInstanceId: 'bot', conversationId: 'chat', tools: ['bad.name'] }] })))
  assert.throws(() => parseBot(botFiles('', { bindings: [{ platform: 'qq', botInstanceId: 'bot', conversationId: 'chat', tools: [], agent: 'legacy' }] })))
})


test('Service inference overrides are strict; personal roles inherit their own settings', () => {
  const settings = { model: 'fixture', temperature: 0, maxTokens: 321, thinking: { type: 'enabled' }, reasoningEffort: 'high' }
  const bot = parseBot(botFiles('', settings))
  for (const [key, value] of Object.entries(settings)) assert.deepEqual((bot as unknown as Record<string, unknown>)[key], value)
  for (const invalid of [{ model: '' }, { temperature: -1 }, { temperature: 3 }, { maxTokens: 0 }, { maxTokens: 1.5 }, { thinking: { type: 'adaptive' } }, { thinking: { type: 'enabled', budget: 1 } }, { reasoningEffort: 'extreme' }, { model: null }]) {
    assert.throws(() => parseBot(botFiles('', invalid)))
  }
  const personal = { mode: 'personal', connection: '11111111-1111-4111-8111-111111111111', agent: 'general', tools: [] }
  assert.doesNotThrow(() => parseBot(botFiles('', personal)))
  assert.throws(() => parseBot(botFiles('', { ...personal, model: 'fixture' })))
})

test('QQ/Feishu binding skills are rejected while Bot-level skill prompts remain supported', () => {
  for (const platform of ['qq', 'feishu']) {
    const binding = { platform, botInstanceId: 'bot', conversationId: 'chat', tools: [] }
    assert.doesNotThrow(() => parseBot(botFiles('', { bindings: [binding], skills: [{ name: 'help', content: 'Helpful context' }] })))
    for (const skills of [[], ['help']]) assert.throws(() => parseBot(botFiles('', { bindings: [{ ...binding, skills }] })))
  }
})
