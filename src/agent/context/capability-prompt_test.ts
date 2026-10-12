import assert from 'node:assert/strict'
import { test } from 'node:test'
import { capabilityDiscovery, capabilityPrompt } from './capability-prompt.ts'
import { guidelineProvider } from './guideline.ts'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import type { SessionPromptContext } from './builder.ts'

const ctx = (mode: SessionPromptContext['mode']): SessionPromptContext => ({
  behavior: {}, sessionId: 'virtual:fixture', channel: 'virtual', chatId: 'fixture', mode,
  agent: { name: 'fixture', description: '', prompt: '', source: 'builtin', defaultMode: 'session' },
})

test('explicit role fragments honor both role and execution-mode capability ceilings', () => {
  const prompt = 'identity\n<!-- capability:work -->work tutorial<!-- /capability -->\n<!-- capability:subagent -->delegate tutorial<!-- /capability -->\n<!-- capability:*;session -->reuse tutorial<!-- /capability -->'
  assert.match(capabilityPrompt(prompt, ctx('session')), /work tutorial/)
  assert.doesNotMatch(capabilityPrompt(prompt, ctx('task')), /work tutorial|reuse tutorial/)
  assert.match(capabilityPrompt(prompt, ctx('task')), /delegate tutorial/)
  assert.equal(capabilityPrompt(prompt, ctx('call')).trim(), 'identity')
  const restricted = ctx('session')
  restricted.agent.allowedTools = ['read']
  assert.doesNotMatch(capabilityPrompt(prompt, restricted), /delegate tutorial|work tutorial/)
})

test('one-shot role and common guidance omit unavailable operation tutorials', async () => {
  for (const agent of await getBuiltinAgentTypes()) {
    for (const mode of ['task', 'call'] as const) {
      const prompt = String(await guidelineProvider().getPromptSection({ ...ctx(mode), agent }))
      assert.doesNotMatch(prompt, /<!-- capability:|### Shared work notes|`work update`|`work review`|Use session for permitted durable peers|### Coordinator Capability Boundary/)
      if (mode === 'call') {
        assert.doesNotMatch(prompt, /### Delegation|## Execution and Delegation|## Task Assessment|### Questions and decisions|### Messaging|Use `skill_read`\/`skill_save`|prefer `task`/)
      }
    }
  }
})

test('one-shot discovery omits scheduling, tracking and remote-task workflows', () => {
  const summary = '<available_skills>\n' + ['cron', 'event-sources', 'initiative', 'a2a', 'chrome-devtools']
    .map(name => `  <skill name="${name}">workflow</skill>\n`).join('') + '</available_skills>'
  assert.match(capabilityDiscovery(summary, ctx('session')), /name="cron"/)
  for (const mode of ['task', 'call'] as const) {
    const hints = capabilityDiscovery(summary, ctx(mode))
    assert.doesNotMatch(hints, /name="(?:cron|event-sources|initiative|a2a)"/)
    assert.match(hints, /name="chrome-devtools"/)
  }
})
