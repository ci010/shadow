import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { parseBot, validateBotInference, botInferenceSettings } from './sdk.ts'
import { botFiles } from './sdk-test-fixture.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots } from './runtime.ts'
import { parseAgentFile } from '../agent/types/parse.ts'
import { inferenceSettings, resolveInferenceSettings } from '../agent/llm-config.ts'

const defaults = { model: 'default', temperature: 0.7, maxTokens: 100, contextWindow: 128000, reasoningEffort: 'low' as const }
const settings = { model: 'chosen', temperature: 0, maxTokens: 321, thinking: { type: 'enabled' as const }, reasoningEffort: 'high' as const }

test('deployed QQ/Feishu and Discord agents carry identical inference into ordinary runtime resolution', async t => {
  const root = join(process.cwd(), '.tmp', `bot-inference-${randomUUID()}`)
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const deployments = new BotDeployments({ directory: root, projectId: 'p', runGit: async () => { throw new Error('No git') } })
  const bindings = ['qq', 'feishu'].map(platform => ({ platform, botInstanceId: 'bot', conversationId: 'chat', tools: [] }))
  const files = botFiles('', { ...settings, bindings: [...bindings, { platform: 'discord', id: randomUUID(), botInstanceId: 'discord', botUserId: '123', enabled: true, trigger: 'mention', participants: { everyone: true, userIds: [], roleIds: [] }, readDomains: [], inheritThreads: false, manage: false, target: { kind: 'channel', guildId: '123', channelId: '456' }, tools: [] }] })
  const frozen = deployments.freeze(files)
  await deployments.deploy({ id: 'demo', source: { folderId: 'f', directory: 'bot' }, ...frozen, signal: new AbortController().signal })
  const runtime = new DirectoryBots(deployments)
  const agents = ['qq', 'feishu'].map(platform => runtime.resolve({ platform: platform as 'qq' | 'feishu', botInstanceId: 'bot', conversationId: 'chat' })!.agent)
  const discord = runtime.discord().agents[0]!
  agents.push(parseAgentFile(discord.markdown, discord.name, root))
  for (const agent of agents) {
    assert.deepEqual(inferenceSettings(agent), settings)
    assert.deepEqual(resolveInferenceSettings(defaults, agent), { ...defaults, ...settings })
    assert.equal(resolveInferenceSettings(defaults, agent, { model: 'session' }).model, 'session')
  }
  assert.deepEqual(resolveInferenceSettings(defaults, botInferenceSettings(parseBot(botFiles()))), defaults)
})

test('deployment inference capability validation uses qualified ids and inherited effort', () => {
  const qualify = (id: string) => `${id}@provider`
  const bot = (input: Record<string, unknown>) => parseBot(botFiles('', input))
  assert.doesNotThrow(() => validateBotInference(bot(settings), defaults, [{ id: 'chosen@provider', reasoningEfforts: ['high'] }], qualify))
  assert.throws(() => validateBotInference(bot(settings), defaults, [], qualify), /catalog/)
  assert.throws(() => validateBotInference(bot(settings), defaults, [{ id: 'chosen@provider', selectable: false }], qualify), /selectable/)
  assert.throws(() => validateBotInference(bot(settings), defaults, [{ id: 'chosen@provider', reasoningEfforts: ['low'] }], qualify), /reasoningEffort/)
  assert.throws(() => validateBotInference(bot({ model: 'chosen' }), defaults, [{ id: 'chosen@provider', reasoningEfforts: ['high'] }], qualify), /reasoningEffort low/)
  assert.throws(() => validateBotInference(bot({ reasoningEffort: 'high' }), defaults, [{ id: 'default@provider', reasoningEfforts: ['low'] }], qualify), /reasoningEffort/)
  assert.doesNotThrow(() => validateBotInference(bot(settings), defaults, [{ id: 'chosen@provider' }], qualify))
  assert.doesNotThrow(() => validateBotInference(bot({ temperature: 0 }), defaults, [], qualify))
})
