import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getBuiltinAgentTypes } from '../types/builtins.ts'
import { guidelineProvider as behaviorProvider, executionModeGuideline } from './guideline.ts'
import { workspaceProvider } from './workspace.ts'
import { memoryProvider } from './memory-provider.ts'
import type { SessionPromptContext } from './builder.ts'
import { EXECUTION_MODES, allowedSubagentModes } from '../../sessions/execution-mode.ts'
import { VirtualFs } from '../../vfs/virtual-fs.ts'
import { MemoryStore } from '../memory.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

function guidelineProvider() {
  return { async getPromptSection(ctx: SessionPromptContext) {
    return `${executionModeGuideline(ctx)}\n\n${await behaviorProvider().getPromptSection(ctx)}`
  } }
}

test('the same role retains tool guidance without generic safety in every execution mode', async () => {
  const roles = await getBuiltinAgentTypes()
  const verify = roles.find(role => role.name === 'verify')!
  assert.equal(verify.defaultMode, 'task')
  for (const mode of EXECUTION_MODES) {
    const prompt = await guidelineProvider().getPromptSection({
      behavior: {}, sessionId: 'fixture:verify', channel: 'fixture', chatId: 'verify',
      agent: verify, mode,
    })
    assert(!prompt?.includes('## Safety'))
    assert(prompt?.includes('## Tool discovery and recovery'))
    assert(prompt?.includes(`## Execution Contract: ${mode[0].toUpperCase()}${mode.slice(1)}`))
    assert.equal(verify.defaultMode, 'task')
    assert.deepEqual(verify.allowedTools, ['read', 'search', 'exec', 'ask', 'reply', 'work'])
  }
})

test('call contract overrides orchestration habits without changing tool restrictions', async () => {
  const general = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
  const prompt = await guidelineProvider().getPromptSection({
    behavior: {}, sessionId: 'fixture:call', channel: 'fixture', chatId: 'call',
    agent: general, mode: 'call',
  })
  assert(prompt?.includes('Do not repeat alignment interviews'))
  assert(prompt?.includes('waiting for your final response as the original tool result'))
  assert(prompt?.includes('you cannot ask, reply, message other sessions, create subagents'))
  assert(prompt?.includes('blocked result immediately'))
  assert(prompt?.includes('{"status":"blocked","reason":'))
  assert(prompt?.includes('{"status":"failed","error":'))
  assert(prompt?.includes('foreground-only'))
  assert(prompt?.includes('120-second execution deadline'))
  assert(prompt?.includes('Do not send a duplicate completion notification'))
  assert(prompt?.includes('Keep role tool constraints and the current environment context'))
  assert(!general.prompt.includes('both are delegated by default'))
  assert(!general.prompt.includes('If you listed a subtask, delegate it'))
})

test('compact call guidance preserves machine-readable outcomes and bounded execution', async () => {
  const roles = await getBuiltinAgentTypes()
  for (const agent of roles) {
    const prompt = (await guidelineProvider().getPromptSection({
      behavior: {}, sessionId: 'fixture:call-contract', channel: 'fixture', chatId: 'call',
      agent, mode: 'call',
    }))!
    const shapes = [...prompt.matchAll(/^\{"status":"(?:blocked|failed)".+$/gm)]
      .map(([json]) => JSON.parse(json))
    assert.equal(shapes.length, 2)
    assert.deepEqual(Object.keys(shapes[0]), ['status', 'reason', 'partialWork'])
    assert.equal(shapes[0].status, 'blocked')
    assert.equal(typeof shapes[0].reason, 'string')
    assert(shapes[0].reason.length > 0)
    assert.equal(typeof shapes[0].partialWork, 'string')
    assert.deepEqual(Object.keys(shapes[1]), ['status', 'error'])
    assert.equal(shapes[1].status, 'failed')
    assert.equal(typeof shapes[1].error, 'string')
    assert(shapes[1].error.length > 0)

    const text = prompt.replace(/\s+/g, ' ')
    for (const rule of [
      /raw JSON without fences or a preamble/,
      /Reasons\/errors must be nonempty; success returns a normal final answer/,
      /These limits override role coordination instructions/,
      /caller decides or asks before issuing a new call/,
      /local and foreground-only: timeout_ms must be 1 through 120000, never zero/,
      /timeout\/cancellation terminates it, never backgrounds it/,
      /120-second execution deadline plus up to 10 seconds for cleanup/,
      /No remote exec or detached work via any tool\/script/,
      /Intermediate work stays in this call's trace/,
      /Inherited context is a snapshot, not a live conversation/,
      /filesystem and other external side effects are not rolled back/,
    ]) assert.match(text, rule, `${agent.name}: ${rule}`)
  }
})

test('durable peers delegate task/call independently of context ancestry', async () => {
  assert.deepEqual(allowedSubagentModes('session', false), ['task', 'call'])
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
  assert(root?.includes('Allowed delegation modes:\ntask, call'))
  assert(child?.includes('Allowed delegation modes:\ntask, call'))
  assert(root?.includes('Durable peers are independent, reusable conversations'))
  assert(child?.includes('Creator metadata and message receipts do not transfer ownership'))
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
  assert.doesNotMatch(root, /mode: "session"/)
  assert.match(root, /mode: "task"/)
  assert.match(root, /mode: "call"/)
  assert.match(root, /v:skills\/orchestration/)
  assert.match(root, /Resolve routine implementation choices yourself/)

  const sub = (await provider.getPromptSection({ ...ctx, parentSessionId: 'fixture:root' }))!
  assert.doesNotMatch(sub, /mode: "session"/)
  assert.match(sub, /mode: "task"/)
  assert.match(sub, /mode: "call"/)
  assert.match(sub, /Only its parent or owner may answer/)

  const task = (await provider.getPromptSection({ ...ctx, mode: 'task', parentSessionId: 'fixture:root' }))!
  assert.doesNotMatch(task, /mode: "session"|mode: "task"|Asynchronous creation|`report_to` redirects/)
  assert.match(task, /mode: "call"/)
  assert.match(task, /Specify `mode: "call"` explicitly/)
  assert.match(task, /Do not create\/manage durable sessions or register folders/)

  const call = (await provider.getPromptSection({ ...ctx, mode: 'call' }))!
  assert.doesNotMatch(call, /### Delegation|### Questions and decisions|### Messaging|fire-and-forget|process keeps running|timeout_ms: 0/)
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
  assert.doesNotMatch(restricted, /### Questions and decisions|### Shell|### Delegation|You may create/)
})

test('ordinary sessions retain standard guidance without a management-only boundary', async () => {
  const context: SessionPromptContext = { behavior: {}, sessionId: 'web:chat-admin', channel: 'web', chatId: 'chat-admin',
    agent: { name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' } }
  const prompt = (await guidelineProvider().getPromptSection(context))!
  assert.doesNotMatch(prompt, /Coordinator Capability Boundary|single Project coordinator|hard runtime cap/)
  assert.match(prompt, /### Shell/)
  assert.match(prompt, /### Delegation/)
})

test('compact coordination guidance retains decision and completion routing protocols', async () => {
  const general = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
  for (const mode of ['session', 'task'] as const) {
    for (const parentSessionId of [undefined, 'fixture:parent']) {
      const prompt = (await guidelineProvider().getPromptSection({
        behavior: {}, sessionId: 'fixture:coordination', channel: 'fixture', chatId: 'coordination',
        agent: general, mode, parentSessionId,
      }))!.replace(/\s+/g, ' ')
      assert.match(prompt, /ask\(kind=input\).*never permission/)
      assert.match(prompt, /ask\(kind=decision\).*scope, budget, permission/)
      assert.match(prompt, /two distinct choices and a matching default, then wait/)
      assert.match(prompt, /A default is not permission to proceed early/)
      assert.match(prompt, /approved:false allows only investigation and authorized unaffected work/)
      assert.match(prompt, /Respect custom answers without treating them as approval/)
      assert.match(prompt, /invalidate the decision and reassess dependent choices; use reconsiders/)
      assert.match(prompt, /Default delivery is next-step; use it for running-task corrections/)
      assert.match(prompt, /Queue is for later work in reusable sessions; silent is FYI only/)
      assert.match(prompt, /never required materials, corrections or unblockers/)
      assert.match(prompt, /completion routing grants no messaging permission/)
      assert.match(prompt, /Message receipts confirm admission, not application, completion or ownership transfer/)
      assert.doesNotMatch(prompt, /LAST message|attention: "blocker"/)
      if (mode === 'session') {
        assert.match(prompt, /Use reply with the exact request_id/)
        assert.match(prompt, /decision replies must match an offered option/)
        assert.match(prompt, /Asynchronous creation admits an ID, not a result/)
        assert.match(prompt, /report_to.*not ownership or decisions, and grants no messaging permission/)
        assert.match(prompt, /do not sleep or poll/)
      } else {
        assert.doesNotMatch(prompt, /action: "answer"/)
        assert.match(prompt, /No follow-up assignments or promises/)
        assert.match(prompt, /only blocking leaf calls. Finish them before reporting your final result/)
      }
    }
  }
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

test('delivery guidance is stable by execution mode, never by triggering sender', async () => {
  const agent = (await getBuiltinAgentTypes()).find(role => role.name === 'general')!
  for (const mode of EXECUTION_MODES) {
    const context: SessionPromptContext = { behavior: {}, sessionId: 'web:fixture', channel: 'web', chatId: 'fixture', agent, mode }
    const prompt = executionModeGuideline(context)
    for (const inputSource of ['user', 'session', 'event'] as const) {
      assert.equal(executionModeGuideline({ ...context, inputSource }), prompt)
    }
    if (mode === 'session') {
      assert.match(prompt, /delivered to this conversation's reader/)
      assert.match(prompt, /Neither a message receipt nor a final response resolves a pending request/)
      assert.match(prompt, /Do not repeat routine coordination or already-reported results/)
    } else {
      assert.doesNotMatch(prompt, /delivered to this conversation's reader/)
      assert.match(prompt, mode === 'call' ? /original tool result/ : /final response ends the task and is reported/)
    }
  }
})
