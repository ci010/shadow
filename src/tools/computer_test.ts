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
    const observed = await invoke('computer_observe', {})
    assert.ok(transientToolSummary(observed))
    assert.match(toolResultText(observed), /Synthetic field/)
    assert.doesNotMatch(transientToolSummary(observed)!, /Synthetic field/)
    const connected = await invoke('computer_setup', { action: 'connect' })
    assert.match(toolResultText(connected), /"observed":true/)
    assert.match(toolResultText(connected), /Synthetic field/)
    assert.doesNotMatch(transientToolSummary(connected)!, /Synthetic field/)
    const stale = await invoke('computer_act', { observationId: crypto.randomUUID(), action: { kind: 'invoke', elementId: '0' } })
    assert.match(toolResultText(stale), /Observe the window again/)
    assert.match(toolResultText(await invoke('computer_setup', { action: 'connect' }, { recoveringToolCall: true })), /not replayed/)
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


test('agent lists, selects and executes through ordinary tools without manual sharing', async t => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(t)
    await f.service.release(owner)
    const base = new Tools(workspace)
    const importer = new ImportTool(new Map(), workspace)
    for (const tool of computerTools(f.service, owner.projectId, id => assert.equal(id, owner.sessionId))) importer.registerBuiltin(tool.name, tool)
    base.register(new InvokeTool(importer))
    const tools = new SessionTools(base, workspace)
    tools.setExecutionScope('session', ['call'])
    const context: ExecutionContext = { ...owner, physicalSessionId: 'fixture', tools, channel: 'web',
      chatId: 'fixture', senderId: 'owner', messageId: 'fixture', signal: f.signal }
    const invoke = (args: Record<string, unknown>, patch: Partial<ExecutionContext> = {}) =>
      tools.execute('invoke_tool', { name: 'computer_setup', args }, { ...context, ...patch })
    assert.match(toolResultText(await invoke({ action: 'status' })), /"grant":null/)
    const before = f.desktop.calls.length
    for (const patch of [{ projectId: 'foreign' }, { scriptInvocation: true }, { channel: 'discord' }]) {
      for (const args of [{ action: 'windows' }, { action: 'select', windowId: f.desktop.window.id }]) {
        assert.match(toolResultText(await invoke(args, patch)), /owning local web conversation/)
      }
    }
    tools.setExecutionScope('call', [])
    assert.match(toolResultText(await invoke({ action: 'windows' })), /owning local web conversation/)
    tools.setExecutionScope('session', ['call'])
    assert.equal(f.desktop.calls.length, before)
    const listed = await invoke({ action: 'windows' })
    assert.match(toolResultText(listed), /Synthetic fixture/)
    assert.doesNotMatch(transientToolSummary(listed)!, /Synthetic fixture|"pid"/)
    assert.equal(f.service.status(owner).grant, null)
    assert.equal(f.desktop.calls.at(-1)?.method, 'list')
    assert.match(toolResultText(await invoke({ action: 'select', windowId: f.desktop.window.id, foregroundInput: true })), /invalid arguments/)
    assert.match(toolResultText(await invoke({ action: 'foreground', targetId: f.desktop.target.id })), /invalid arguments/)
    assert.match(toolResultText(await invoke({ action: 'select', windowId: crypto.randomUUID() })), /Refresh/)
    assert.match(toolResultText(await invoke({ action: 'select', windowId: f.desktop.window.id }, { recoveringToolCall: true })), /not replayed/)
    await invoke({ action: 'select', windowId: f.desktop.window.id })
    assert.deepEqual(f.desktop.calls.at(-1), { method: 'bind', windowId: f.desktop.window.id })
    await tools.execute('invoke_tool', { name: 'computer_observe', args: { targetId: f.desktop.target.id } }, context)
    const action = tools.execute('invoke_tool', { name: 'computer_act', args: f.input() }, context)
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.desktop.calls.some(call => call.method === 'act'), true)
    await action
    await invoke({ action: 'release' })
    assert.equal(f.service.status(owner).grant, null)
    await tools.resetDynamicAndWait()
  })
})
