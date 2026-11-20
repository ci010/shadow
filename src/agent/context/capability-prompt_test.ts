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
        assert.doesNotMatch(prompt, /### Delegation|## Execution and Delegation|## Task Assessment|### Questions and decisions|### Messaging|v:skills\/\.raw\/|prefer `task`/)
      }
    }
  }
})

test('V2 specialist prompts retain role policy and honor actual mode and tool ceilings', async () => {
  const roles = await getBuiltinAgentTypes()
  assert.equal(roles.some(role => role.name === 'research'), false)
  const expected = {
    sub: { defaultMode: 'session', blockedTools: ['cron'] },
    verify: { defaultMode: 'task', allowedTools: ['workspace_use', 'read', 'search', 'exec', 'ask', 'reply', 'work', 'task'], soul: false },
    plan: { defaultMode: 'session', allowedTools: ['workspace_use', 'read', 'search', 'plan_write', 'ask', 'reply', 'work'] },
    explore: { defaultMode: 'session', allowedTools: ['workspace_use', 'read', 'search', 'exec', 'ask', 'reply', 'work'] },
  }
  for (const [name, baseline] of Object.entries(expected)) {
    const agent = roles.find(role => role.name === name)!
    const { defaultMode, allowedTools, blockedTools, soul } = agent
    assert.deepEqual({ defaultMode, allowedTools, blockedTools, soul }, {
      allowedTools: undefined, blockedTools: undefined, soul: undefined, ...baseline,
    })
    for (const mode of ['session', 'task', 'call'] as const) {
      const prompt = String(await guidelineProvider().getPromptSection({ ...ctx(mode), agent }))
      assert.doesNotMatch(prompt, /<!-- capability:/)
      if (name !== 'sub') assert.doesNotMatch(prompt, /direct `write`|use `write`|Read\/write `v:sessions\/self\.json`|### Delegation|For MCP recovery/)
      if (name === 'sub') {
        assert.match(prompt, /exact replacement/)
        assert.equal(prompt.includes('Task discovery title and description are parent-owned'), mode === 'task')
        assert.equal(prompt.includes('Delegate only a bounded independent result'), mode !== 'call')
      }
      if (name === 'verify') {
        assert.match(prompt, /Verification is not repair/)
        assert.equal(prompt.includes('only the designated reviewer may use'), mode !== 'call')
      }
      if (name === 'plan') {
        assert.match(prompt, /Do not execute the plan/)
        assert.match(prompt, /Use `plan_write`/)
        assert.doesNotMatch(prompt, /### Shell|Use `exec`/)
      }
      if (name === 'explore') {
        assert.match(prompt, /Stay read-only/)
        assert.doesNotMatch(prompt, /`work_update`|writes use dynamic/)
        assert.equal(prompt.includes('Do not update it.'), mode === 'session')
      }
    }
  }
})

test('one-shot discovery omits scheduling, tracking and remote-task workflows', () => {
  const summary = '<available_skills>\n' + ['cron', 'signal-sources', 'work-notes', 'a2a', 'peer-sessions', 'work-coordination', 'chrome-devtools']
    .map(name => `  <skill name="${name}">workflow</skill>\n`).join('') + '</available_skills>'
  assert.match(capabilityDiscovery(summary, ctx('session')), /name="cron"/)
  for (const mode of ['task', 'call'] as const) {
    const hints = capabilityDiscovery(summary, ctx(mode))
    assert.doesNotMatch(hints, /name="(?:cron|signal-sources|work-notes|a2a|peer-sessions|work-coordination)"/)
    assert.match(hints, /name="chrome-devtools"/)
  }
})
