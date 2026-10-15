import assert from 'node:assert/strict'
import test from 'node:test'
import { computerTools } from './computer.ts'
import { Tools, SessionTools } from './registry.ts'
import { ImportTool } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { ToolOutcomeUnknownError, transientToolSummary, toolResultText } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import { fixture, owner } from '../computer/testing/fixture.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { CoordinatorExecutionPolicy } from '../execution/coordinator-policy.ts'
import type { Executor } from '../execution/executor.ts'

test('computer tools use lazy discovery, preserve transient observations through invoke_tool, and deny borrowed/script/remote calls', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t)
    const base = new Tools(workspace)
    const importer = new ImportTool(new Map(), workspace)
    for (const tool of computerTools(f.service, owner.projectId, id => assert.equal(id, owner.sessionId))) importer.registerBuiltin(tool.name, tool)
    base.register(new InvokeTool(importer))
    const tools = new SessionTools(base, workspace)
    tools.setExecutionScope('session', ['call'])
    const context: ExecutionContext = {
      ...owner, physicalSessionId: 'fixture-physical', tools, channel: 'web', chatId: 'fixture', senderId: 'owner',
      messageId: 'fixture', signal: f.signal, toolCallId: 'fixture-observe', toolCallName: 'invoke_tool',
    }
    const invoke = (name: string, args: Record<string, unknown>, patch: Partial<ExecutionContext> = {}) =>
      tools.execute('invoke_tool', { name, args }, { ...context, ...patch })
    const observed = await invoke('computer_observe', { targetId: f.desktop.target.id })
    assert.ok(transientToolSummary(observed))
    assert.match(toolResultText(observed), /Synthetic field/)
    assert.doesNotMatch(transientToolSummary(observed)!, /Synthetic field/)
    const before = f.desktop.calls.length
    const executor: Executor = {
      async *execute() { assert.fail('No remote desktop execution is implemented') },
      async getStatus() { assert.fail('No remote desktop status is implemented') },
      async cancel() { assert.fail('No remote desktop cancellation is implemented') },
    }
    for (const patch of [{ projectId: 'foreign' }, { scriptInvocation: true }, { channel: 'discord' }]) {
      assert.match(toolResultText(await invoke('computer_observe', { targetId: f.desktop.target.id }, patch)), /owning local web conversation/)
    }
    assert.match(toolResultText(await invoke('computer_observe', { targetId: f.desktop.target.id },
      { remoteWorkdir: { nodeId: 'child', capabilityId: 'opaque', executor } })), /remote workdirs/)
    tools.setExecutionScope('call', [])
    assert.match(toolResultText(await invoke('computer_observe', { targetId: f.desktop.target.id })), /owning local web conversation/)
    tools.setExecutionScope('session', ['call'])
    assert.equal(f.desktop.calls.length, before)
    assert.match(toolResultText(await invoke('computer_setup', { action: 'approve' })), /invalid arguments/)
    await assert.rejects(invoke('computer_act', f.input(), { recoveringToolCall: true }), ToolOutcomeUnknownError)
    assert.equal(f.service.status(owner).pending, null)
    await tools.resetDynamicAndWait()
  })
})

test('disabled Main policy denies computer tool import and already imported execution before any desktop work', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t)
    const policy = new CoordinatorExecutionPolicy()
    const base = new Tools(workspace)
    base.setExecutionPolicy(policy.check)
    const importer = new ImportTool(new Map(), workspace, undefined, undefined, undefined, policy.canImport)
    const invoke = new InvokeTool(importer)
    base.register(invoke)
    policy.allow(invoke)
    const tools = new SessionTools(base, workspace)
    const context: ExecutionContext = { ...owner, physicalSessionId: 'fixture', tools, signal: f.signal,
      messageId: 'fixture', channel: 'web', chatId: 'fixture', senderId: 'owner' }
    const before = f.desktop.calls.length
    for (const tool of computerTools(f.service, owner.projectId, () => assert.fail('Session validation must not run'))) {
      const args = tool.name === 'computer_setup' ? { action: 'status' }
        : tool.name === 'computer_observe' ? { targetId: f.desktop.target.id } : f.input()
      importer.registerBuiltin(tool.name, tool)
      assert.match(toolResultText(await tools.execute('invoke_tool', { name: tool.name, args }, context)), /local executor is disabled/)
      tools.registerDynamic(tool)
      assert.match(toolResultText(await tools.executeDynamic(tool.name, args, context)), /local executor is disabled/)
    }
    assert.equal(f.desktop.calls.length, before)
    await tools.resetDynamicAndWait()
  })
})
