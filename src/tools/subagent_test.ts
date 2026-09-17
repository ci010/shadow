import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { Bus } from '../bus/bus.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { SubagentTool } from './subagent.ts'

test('subagent only creates temporary work, preserving explicit workdir and ignoring reusable role defaults', async () => {
  const workdir = { version: 1 as const, nodeId: 'node-a', capabilityId: 'folder-a' }
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
  assert.match(await tool.execute({ mode: 'session', description: 'Legacy' }, context), /topic creation/)
  assert.equal(createdId, '')
  assert.match(await tool.execute({ description: 'No task' }, context), /task is required/)
  const receipt = JSON.parse(await tool.execute({ description: 'Work', task: 'Do work' }, context))
  assert.equal(receipt.mode, 'task')
  assert.match(createdId, /^virtual:general-/)
  assert.equal(fields?.mode, 'task')
  assert.equal(fields?.workspaceRoot, 'discord:root')
  assert.equal(fields?.workdir, workdir)
  assert.equal(fields?.folderId, 'folder-a')
  assert.equal(fields?.parentSessionId, parent.sessionId)
  assert.equal(starts, 1)
  parent.agentType = 'orchestrator'
  assert.equal(await tool.execute({ mode: 'call', description: 'Leaf', task: 'Inspect' }, context), 'Call result')
  assert.equal(calls, 1)
  assert.equal(fields?.agentType, 'general')
  assert.equal(fields?.reportTo, undefined)
  assert.match(await tool.execute({ mode: 'task', agent_type: 'orchestrator', description: 'Alias', task: 'Work' }, context), /cannot be used/)
})
