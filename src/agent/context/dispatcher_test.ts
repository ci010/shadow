import assert from 'node:assert/strict'
import test from 'node:test'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import { runtimeDiscoveryProvider, type RuntimeProviderDeps } from './runtime.ts'
import type { SessionPromptContext } from './builder.ts'

test('dispatcher uses a hidden role and never requests the general skill catalog', async () => {
  const agent = (await getBuiltinAgentTypes()).find(role => role.name === 'dispatcher')
  assert(agent, 'Built-in dispatcher is required')
  assert.equal(agent.root, true)
  assert.equal(agent.skills, false)
  assert.equal(agent.soul, false)
  const context = {
    projectId: 'fixture', sessionId: 'cron:fixture', channel: 'cron', chatId: 'fixture',
    mode: 'task', agent, behavior: {},
  } as SessionPromptContext
  const provider = runtimeDiscoveryProvider({
    projectId: 'fixture',
    getSkillsSummary: () => { throw new Error('Dispatcher must not load a skill catalog') },
    getAgentTypesSummary: () => '',
  } as unknown as RuntimeProviderDeps)
  const prompt = await provider.getPromptSection(context)
  assert.doesNotMatch(prompt ?? '', /available_skills/)
})
