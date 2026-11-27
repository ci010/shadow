import assert from 'node:assert/strict'
import test from 'node:test'
import { channelCapabilityPrompt } from './runtime.ts'
import { toolsContract, toolsGuideline } from './tools-guideline.ts'
import { executionModeGuideline } from './guideline.ts'
import type { SessionPromptContext } from './builder.ts'
import { unavailableCapabilities } from '../../channels/capabilities.ts'

test('QQ and Discord guidance asks in ordinary chat rather than promising interactive forms', () => {
  for (const channel of ['qq', 'discord', 'web', 'feishu']) {
    const context: SessionPromptContext = { channel, sessionId: `${channel}:test`, chatId: 'test', behavior: {},
      agent: { name: 'general', description: '', prompt: '', source: 'builtin', defaultMode: 'session', root: false, allowedTools: ['ask'] } }
    const prompt = [toolsGuideline(context), executionModeGuideline(context),
      channelCapabilityPrompt(channel, unavailableCapabilities(), false, true, false)].join('\n')
    if (channel === 'qq' || channel === 'discord') {
      assert.match(prompt, /normal chat response and end the turn/)
      assert.doesNotMatch(prompt, /Use ask\(kind=|Use ask for|two distinct suggested/)
      assert.match(prompt, /dedicated owner approval/)
    } else assert.match(prompt, /Use ask for/)
  }
})

test('only root Web general is instructed to gather and batch clarification', () => {
  const general: SessionPromptContext = { channel: 'web', sessionId: 'web:test', chatId: 'test', behavior: {},
    agent: { name: 'general', description: '', prompt: '', source: 'builtin', defaultMode: 'session', root: false, allowedTools: ['ask'] } }
  for (const render of [toolsGuideline, toolsContract]) {
    const prompt = render(general)
    assert.match(prompt, /Gather material uncertainties before asking/)
    assert.match(prompt, /ask\(\{questions:\[\{content, options\}/)
    assert.match(prompt, /Do not scatter independent questions across separate waits/)
    const sub = render({ ...general, agent: { ...general.agent, name: 'sub' }, mode: 'task', parentSessionId: 'web:parent' })
    assert.match(sub, /ask\(kind=input\)/)
    for (const context of [
      { ...general, agent: { ...general.agent, name: 'sub' } },
      { ...general, parentSessionId: 'web:parent' },
      { ...general, isGroup: true },
      { ...general, channel: 'feishu', sessionId: 'feishu:test' },
      { ...general, mode: 'task' as const },
      { ...general, agent: { ...general.agent, allowedTools: ['read'] } },
    ]) assert.doesNotMatch(render(context), /Clarification rounds with the user/)
  }
  assert.doesNotMatch(toolsContract({ ...general, offeredTools: new Set() }), /Clarification rounds with the user/)
})
