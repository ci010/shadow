import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { Bus } from '../bus/bus.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { SubagentTool } from './subagent.ts'
import type { InferenceSettings } from '../agent/llm-config.ts'
import { Tools } from './registry.ts'

test('subagent only creates temporary work, preserving explicit workdir and ignoring reusable role defaults', async () => {
  const workdir = { version: 2 as const, nodeId: 'node-a', workdirId: 'folder-a' }
  const parent: SessionState = {
    sessionId: 'discord:parent', segmentIndex: 3, mode: 'session',
    workspaceRoot: 'discord:root', workdir, folderId: 'folder-a',
  }
  let fields: Parameters<SessionManager['buildSession']>[2]
  let createdId = ''
  let starts = 0
  let calls = 0
  const sessions = {
    assertCanCreateChild: () => {},
    getAllowedSubagentModes: () => ['task', 'call'],
    getSessionState: () => parent,
    executeOnce: (_key: string, run: () => Promise<string>) => run(),
    buildSession: async (id: string, _parent: unknown, next: typeof fields) => { createdId = id; fields = next },
    configureTaskReview: async () => {},
    startChild: async () => { starts++ },
    startCall: async () => { calls++; return 'Call result' },
  } as unknown as SessionManager
  const types = {
    resolve: () => ({ name: 'general', defaultMode: 'session' }),
    allNames: () => ['general'],
  } as unknown as AgentTypesManager
  const channels = { createThread: () => { throw new Error('Temporary work must not create a thread') } } as unknown as ChannelManager
  const tool = new SubagentTool({} as Bus, sessions, types, channels)
  const context = {
    channel: 'discord', chatId: 'parent', senderId: 'user', messageId: 'input',
    sessionId: parent.sessionId, physicalSessionId: 'physical',
  } as ExecutionContext
  assert.deepEqual(tool.parameters.properties.mode.enum, ['task', 'call'])
  assert.deepEqual(tool.parameters.required, ['description', 'task'])
  assert.match(await tool.execute({ mode: 'session', description: 'Legacy' }, context), /session creation/)
  assert.equal(createdId, '')
  assert.match(await tool.execute({ description: 'No task' }, context), /task is required/)
  const receipt = JSON.parse(await tool.execute({ description: 'Work', task: 'Do work' }, context))
  assert.equal(receipt.mode, 'task')
  assert.match(createdId, /^virtual:general-/)
  assert.equal(fields?.mode, 'task')
  assert.equal(fields?.name, 'Work')
  assert.equal(fields?.description, 'Work')
  await tool.execute({ mode: 'task', title: 'Parent title', description: 'Parent description', task: 'Do work' }, context)
  assert.equal(fields?.name, 'Parent title')
  assert.equal(fields?.description, 'Parent description')
  await assert.rejects(tool.execute({ mode: 'task', title: ' ', description: 'Purpose', task: 'Work' }, context), /session name/)
  assert.match(await tool.execute({ mode: 'task', title: 'Title', description: 'x'.repeat(4001), task: 'Work' }, context), /4000/)
  assert.equal(fields?.workspaceRoot, 'discord:root')
  assert.equal(fields?.workdir, workdir)
  assert.equal(fields?.folderId, 'folder-a')
  assert.equal(fields?.parentSessionId, parent.sessionId)
  assert.equal(starts, 2)
  parent.agentType = 'general'
  assert.equal(await tool.execute({ mode: 'call', title: 'Ignored call title', description: 'Leaf', task: 'Inspect' }, context), 'Call result')
  assert.equal(calls, 1)
  assert.equal(fields?.name, undefined)
  assert.equal(fields?.description, 'Leaf')
  assert.equal(fields?.agentType, 'general')
  assert.equal(fields?.reportTo, undefined)
})

test('subagent permits task inference overrides but calls reject explicit fields and inherit caller settings', async () => {
  const parent: SessionState = { sessionId: 'web:parent', mode: 'session', segmentIndex: 0, config: { model: 'parent', reasoningEffort: 'high' } }
  const fields: Array<Parameters<SessionManager['buildSession']>[2]> = []
  const validated: InferenceSettings[] = []
  const sessions = {
    getSessionState: () => parent, getAllowedSubagentModes: () => ['task', 'call'], assertCanCreateChild() {},
    executeOnce: (_key: string, run: () => Promise<string>) => run(),
    validateExecutionInference: async (settings: InferenceSettings) => {
      if (settings.model === 'unsupported') throw new Error('Model is not selectable')
      validated.push(settings)
    },
    buildSession: async (_id: string, _parent: unknown, value: Parameters<SessionManager['buildSession']>[2]) => { fields.push(value) },
    configureTaskReview: async () => {},
    startChild: async () => {}, startCall: async () => 'result',
  } as unknown as SessionManager
  const types = { resolve: () => ({ name: 'general', model: 'role', reasoningEffort: 'low' }), allNames: () => ['general'] } as unknown as AgentTypesManager
  const tool = new SubagentTool({} as Bus, sessions, types, {} as ChannelManager)
  const context = { sessionId: parent.sessionId, physicalSessionId: 'physical', messageId: 'input' } as ExecutionContext
  await tool.execute({ description: 'Task', task: 'Work', model: 'chosen', effort: 'medium' }, context)
  assert.deepEqual(fields[0]?.config, { model: 'chosen', reasoningEffort: 'medium' })
  for (const overrides of [
    { model: 'chosen' }, { model: 'parent' }, { effort: 'low' }, { effort: 'high' },
    { model: 'parent', effort: 'high' }, { model: null }, { effort: null },
    { model: undefined }, { effort: undefined },
  ]) {
    assert.match(await tool.execute({ mode: 'call', description: 'Call', task: 'Inspect', ...overrides }, context), /cannot specify model or effort/)
  }
  assert.equal(fields.length, 1)
  assert.equal(validated.length, 1)
  context.model = 'active-caller'
  context.reasoningEffort = 'medium'
  await tool.execute({ mode: 'call', description: 'Call', task: 'Inspect' }, context)
  assert.deepEqual(fields[1]?.config, { model: 'active-caller', reasoningEffort: 'medium' })
  await tool.execute({ mode: 'call', description: 'Call fallback', task: 'Inspect' }, { ...context, model: undefined, reasoningEffort: undefined })
  assert.deepEqual(fields[2]?.config, parent.config)
  assert.equal(validated[0]?.model, 'chosen')
  await assert.rejects(tool.execute({ description: 'Bad', task: 'Work', effort: 'invalid' }, context))
  await assert.rejects(tool.execute({ description: 'Bad', task: 'Work', model: 'unsupported' }, context), /not selectable/)
  assert.equal(fields.length, 3)
})

// Exercise the public registry gate, not just SubagentTool.execute: this was
// where remote parents were rejected before orchestration could run on Main.
test('registry delegates remote tasks with opaque parent binding and rejects calls before creation', async () => {
  const workdir = { version: 2 as const, nodeId: 'child-node', workdirId: 'opaque-folder', displayPathSnapshot: 'Z:\\not-a-main-path' }
  const parent: SessionState = { sessionId: 'web:parent', segmentIndex: 2, mode: 'session', workdir, folderId: 'registered-folder', workspaceRoot: 'web:root' }
  const fields: Array<Parameters<SessionManager['buildSession']>[2]> = []
  let starts = 0
  let calls = 0
  const sessions = {
    getSessionState: () => parent, getAllowedSubagentModes: () => ['task', 'call'], assertCanCreateChild() {},
    executeOnce: (_key: string, run: () => Promise<string>) => run(),
    buildSession: async (_id: string, _parent: unknown, next: Parameters<SessionManager['buildSession']>[2]) => { fields.push(next) },
    configureTaskReview: async () => {},
    startChild: async () => { starts++ }, startCall: async () => { calls++; return 'unexpected' },
  } as unknown as SessionManager
  const types = { resolve: () => ({ name: 'general' }), allNames: () => ['general'] } as unknown as AgentTypesManager
  const tools = new Tools('.')
  tools.register(new SubagentTool({} as Bus, sessions, types, {} as ChannelManager))
  const context = {
    sessionId: parent.sessionId, physicalSessionId: 'parent-2', messageId: 'input',
    tools, signal: new AbortController().signal,
    remoteWorkdir: { nodeId: workdir.nodeId, workdirId: workdir.workdirId, executor: {} },
  } as unknown as ExecutionContext
  for (const mode of [undefined, 'task']) {
    const result = await tools.execute('subagent', { ...(mode ? { mode } : {}), task: 'Inspect the child folder', description: 'Remote task' }, context)
    assert.equal(typeof result, 'string')
    assert.equal(JSON.parse(result as string).mode, 'task')
    const child = fields.at(-1)!
    assert.deepEqual(child?.workdir, workdir)
    assert.equal(child?.folderId, parent.folderId)
    assert.equal(child?.workspaceRoot, parent.workspaceRoot)
  }
  assert.equal(starts, 2)
  const result = await tools.execute('subagent', { mode: 'call', task: 'Inspect', description: 'Remote call' }, context)
  assert.match(String(result), /call mode is not supported on remote workdirs/)
  assert.match(String(result), /Use task mode.*no subagent was started/)
  assert.equal(fields.length, 2)
  assert.equal(calls, 0)
  for (const binding of [undefined, { ...workdir, workdirId: 'stale' }]) {
    parent.workdir = binding
    const denied = await tools.execute('subagent', { mode: 'task', task: 'Inspect', description: 'Stale context' }, context)
    assert.match(String(denied), /remote parent workdir binding is missing or changed/)
    assert.equal(fields.length, 2, 'Never fall back to Main when the parent binding is stale')
  }
})
