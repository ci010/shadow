import assert from 'node:assert/strict'
import test from 'node:test'
import { channelCapabilityPrompt } from './runtime.ts'
import { toolsGuideline } from './tools-guideline.ts'
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
