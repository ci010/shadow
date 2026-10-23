import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { ConfigSchema } from './schema.ts'
import { parseModelSpec } from '../providers/aggregated.ts'

test('new configurations default to Astra through Copilot with medium effort', () => {
  const config = ConfigSchema.parse({})
  assert.deepEqual(parseModelSpec(config.agent.model), { model: 'gpt-6-astra', provider: 'copilot' })
  assert.equal(config.agent.reasoningEffort, 'medium')
})

test('explicit model and effort selections survive loading', () => {
  const config = ConfigSchema.parse({ agent: { model: 'claude-sonnet-4.6', reasoningEffort: 'high' } })
  assert.equal(config.agent.model, 'claude-sonnet-4.6')
  assert.equal(config.agent.reasoningEffort, 'high')
})

test('QQ defaults existing and new bot configurations to mention-only triggering', () => {
  assert.equal(ConfigSchema.parse({ channels: { qq: {} } }).channels.qq?.triggerMode, 'mention')
  for (const triggerMode of ['mention', 'all']) {
    assert.equal(ConfigSchema.parse({ channels: { qq: { triggerMode } } }).channels.qq?.triggerMode, triggerMode)
  }
  for (const triggerMode of ['invalid', true, null]) {
    assert.equal(ConfigSchema.safeParse({ channels: { qq: { triggerMode } } }).success, false)
  }
})

test('Node-only execution is an explicit boolean opt-in and preserves other configuration', () => {
  assert.equal(ConfigSchema.parse({}).tools.exec, undefined)
  assert.equal(ConfigSchema.parse({ tools: { exec: {} } }).tools.exec?.nodeOnly, undefined)
  for (const nodeOnly of [true, false]) {
    const exec = ConfigSchema.parse({ tools: { exec: { nodeOnly, defaultShell: 'powershell', timeoutMs: 1234 } } }).tools.exec
    assert.equal(exec?.nodeOnly, nodeOnly)
    assert.equal(exec?.defaultShell, 'powershell')
    assert.equal(exec?.timeoutMs, 1234)
  }
  for (const nodeOnly of ['true', 1, null]) {
    assert.equal(ConfigSchema.safeParse({ tools: { exec: { nodeOnly } } }).success, false)
  }
})

test('legacy voice configuration is rejected rather than silently ignored', () => {
  assert.equal(ConfigSchema.safeParse({ voice: { sttUrl: 'http://localhost:8000' } }).success, false)
})

test('example config agrees with the application defaults', async () => {
  const example = ConfigSchema.parse(JSON.parse(await readFile(new URL('../../bot.config.example.json', import.meta.url), 'utf8')))
  const defaults = ConfigSchema.parse({})
  assert.equal(example.agent.model, defaults.agent.model)
  assert.equal(example.agent.reasoningEffort, defaults.agent.reasoningEffort)
})

test('trusted audiences require explicit valid conversation IDs, not sender or admin configuration', () => {
  for (const platform of ['discord', 'qq', 'feishu'] as const) {
    const untrusted = ConfigSchema.parse({
      channels: { [platform]: { allowFrom: ['alice'], adminChats: ['room'] } },
    })
    assert.equal(untrusted.channels[platform]?.trustedChats, undefined)
    const trusted = ConfigSchema.parse({
      channels: { [platform]: { trustedChats: [' room ', 'thread'] } },
    })
    assert.deepEqual(trusted.channels[platform]?.trustedChats, ['room', 'thread'])
    assert.equal(trusted.channels[platform]?.adminChats, undefined)
    for (const trustedChats of ['room', [123], [''], [' '], ['room\n'], ['room\nother'], Array(1001).fill('room')]) {
      assert.equal(ConfigSchema.safeParse({ channels: { [platform]: { trustedChats } } }).success, false)
    }
  }
})
