import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import { guidelineProvider } from './guideline.ts'
import { workspaceProvider } from './workspace.ts'
import { memoryProvider } from './memory-provider.ts'
import type { SessionPromptContext } from './builder.ts'
import { EXECUTION_MODES, allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { MemoryStore } from '../memory.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

test('the same role retains safety and tool guidance in every execution mode', async () => {
  const roles = await getBuiltinAgentTypes()
  const verify = roles.find(role => role.name === 'verify')!
  assert.equal(verify.defaultMode, 'task')
  for (const mode of EXECUTION_MODES) {
    const prompt = await guidelineProvider().getPromptSection({
      behavior: {}, sessionId: 'fixture:verify', channel: 'fixture', chatId: 'verify',
      agent: verify, mode,
    })
    assert(prompt?.includes('## Safety'))
    assert(prompt?.includes('Don\'t exfiltrate private data'))
    assert(prompt?.includes('## Tools Guide'))
    assert(prompt?.includes(`## Execution Contract: ${mode[0].toUpperCase()}${mode.slice(1)}`))
    assert.equal(verify.defaultMode, 'task')
    assert.deepEqual(verify.allowedTools, ['read', 'search', 'exec', 'yield'])
  }
})

test('call contract overrides orchestration habits without dropping safety', async () => {
  const general = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
  const prompt = await guidelineProvider().getPromptSection({
    behavior: {}, sessionId: 'fixture:call', channel: 'fixture', chatId: 'call',
    agent: general, mode: 'call',
  })
  assert(prompt?.includes('Do not repeat alignment interviews'))
  assert(prompt?.includes('waiting for your final response as the original tool result'))
  assert(prompt?.includes('you cannot yield, message other sessions, create subagents'))
  assert(prompt?.includes('blocked result immediately'))
  assert(prompt?.includes('{"status":"blocked","reason":'))
  assert(prompt?.includes('{"status":"failed","error":'))
  assert(prompt?.includes('foreground-only'))
  assert(prompt?.includes('120-second execution deadline'))
  assert(prompt?.includes('Do not send a duplicate completion notification'))
  assert(prompt?.includes('all safety rules'))
  assert(!general.prompt.includes('both are delegated by default'))
  assert(!general.prompt.includes('If you listed a subtask, delegate it'))
})

test('delegation capabilities narrow by structural role, not agent type or context ancestry', async () => {
  assert.deepEqual(allowedSubagentModes('session', false), ['session', 'task'])
  assert.deepEqual(allowedSubagentModes('session', true), ['task', 'call'])
  for (const parent of [false, true]) {
    assert.deepEqual(allowedSubagentModes('task', parent), ['call'])
    assert.deepEqual(allowedSubagentModes('call', parent), [])
  }
  const general = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
  const context: SessionPromptContext = {
    behavior: {}, sessionId: 'fixture:session', channel: 'fixture', chatId: 'session',
    agent: general, mode: 'session',
  }
  const root = await guidelineProvider().getPromptSection(context)
  const child = await guidelineProvider().getPromptSection({ ...context, parentSessionId: 'fixture:root' })
  assert(root?.includes('This is a root session. Allowed delegation modes:\nsession, task'))
  assert(child?.includes('This is a sub-session. Allowed delegation modes:\ntask, call'))
  assert.equal(general.root, true)
})

test('prompt guides expose only current delegation modes and permitted coordination tools', async () => {
  const roles = await getBuiltinAgentTypes()
  const general = roles.find(role => role.name === 'general')!
  const ctx: SessionPromptContext = {
    behavior: {}, sessionId: 'fixture:scoped', channel: 'fixture', chatId: 'scoped',
    agent: general, mode: 'session',
  }
  const provider = guidelineProvider()
  const root = (await provider.getPromptSection(ctx))!
  assert.match(root, /mode: "session"/)
  assert.match(root, /mode: "task"/)
  assert.doesNotMatch(root, /mode: "call"|blocking call|leaf call|120-second/)
  assert.match(root, /request goes to the human/)

  const sub = (await provider.getPromptSection({ ...ctx, parentSessionId: 'fixture:root' }))!
  assert.doesNotMatch(sub, /mode: "session"/)
  assert.match(sub, /mode: "task"/)
  assert.match(sub, /mode: "call"/)
  assert.match(sub, /request goes to your actual parent/)

  const task = (await provider.getPromptSection({ ...ctx, mode: 'task', parentSessionId: 'fixture:root' }))!
  assert.doesNotMatch(task, /mode: "session"|mode: "task"|Asynchronous creation|`report_to` redirects/)
  assert.match(task, /mode: "call"/)

  const call = (await provider.getPromptSection({ ...ctx, mode: 'call' }))!
  assert.doesNotMatch(call, /### Delegation|### Decisions|### Messaging|fire-and-forget|process keeps running|timeout_ms: 0/)
  assert.match(call, /foreground-only/)

  for (const role of roles.filter(role => ['explore', 'verify', 'plan'].includes(role.name))) {
    for (const mode of EXECUTION_MODES) {
      const prompt = (await provider.getPromptSection({ ...ctx, agent: role, mode }))!
      assert.doesNotMatch(prompt, /### Delegation|### Messaging|You may create/)
      if (role.name === 'plan') assert.doesNotMatch(prompt, /### Shell/)
      if (mode !== 'call') assert.doesNotMatch(prompt, /blocking call|leaf call/)
    }
  }
  const restricted = (await provider.getPromptSection({
    ...ctx, mode: 'task', agent: { ...general, allowedTools: ['read', 'search'] },
  }))!
  assert.doesNotMatch(restricted, /### Decisions|Use yield|### Shell|### Delegation|You may create/)
})

test('soul and memory role policy is independent of invocation lifetime', async () => {
  await withTempWorkspace(async workspace => {
    await writeFile(join(workspace, 'SOUL.md'), 'Fixture shared identity')
    const general = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
    const memory = new MemoryStore(workspace)
    const provider = memoryProvider(memory, () => undefined)
    const workspaceContext = workspaceProvider(workspace, new VirtualFs())
    let firstWorkspace: string | null | undefined
    let firstMemory: string | null | undefined
    for (const mode of EXECUTION_MODES) {
      const context: SessionPromptContext = {
        behavior: {}, sessionId: 'fixture:context', channel: 'fixture', chatId: 'context',
        agent: general, mode,
      }
      const workspacePrompt = await workspaceContext.getPromptSection(context)
      const memoryPrompt = await provider.getPromptSection(context)
      assert(workspacePrompt?.includes('Fixture shared identity'))
      if (mode === 'session') {
        firstWorkspace = workspacePrompt
        firstMemory = memoryPrompt
      } else {
        assert.equal(workspacePrompt, firstWorkspace)
        assert.equal(memoryPrompt, firstMemory)
      }
      const withoutSoul = await workspaceContext.getPromptSection({
        ...context, agent: { ...general, soul: false },
      })
      assert(!withoutSoul?.includes('Fixture shared identity'))
    }
  })
})
