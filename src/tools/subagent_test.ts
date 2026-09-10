import { deepEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import type { AgentTypesManager } from '../agent/agent-types/manager.ts'
import type { Bus } from '../bus/bus.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { SubagentTool } from './subagent.ts'

test('nested subagent inherits explicit workdir and legacy workspace root', async () => {
  const parentWorkdir = {
    version: 1 as const,
    nodeId: 'node-a',
    capabilityId: 'project-a',
  }
  const parentState: SessionState = {
    sessionId: 'discord:parent',
    segmentIndex: 3,
    workspaceRoot: 'discord:root',
    workdir: parentWorkdir,
    projectId: 'folder-project-a',
  }
  let childFields: Parameters<SessionManager['buildSession']>[2]

  const sessions = {
    getSessionState: () => parentState,
    buildSession: (
      _sessionId: string,
      _parent: unknown,
      fields: Parameters<SessionManager['buildSession']>[2],
    ) => {
      childFields = fields
      return Promise.resolve()
    },
    isEphemeralSession: () => Promise.resolve(false),
    addChild: () => Promise.resolve(),
  } as unknown as SessionManager
  const agentTypes = {
    resolve: () => ({
      name: 'sub',
      description: '',
      prompt: '',
      ephemeral: false,
      source: 'builtin',
    }),
    allNames: () => ['sub'],
  } as unknown as AgentTypesManager
  const channels = {
    createThread: () => Promise.resolve(null),
  } as unknown as ChannelManager
  const tool = new SubagentTool(
    {} as Bus,
    sessions,
    agentTypes,
    channels,
  )

  await tool.execute(
    { description: 'nested task' },
    {
      channel: 'discord',
      chatId: 'parent',
      senderId: 'user',
      messageId: 'message',
      sessionId: 'discord:parent',
      physicalSessionId: 'discord_parent__3',
    } as ExecutionContext,
  )

  assertEquals(childFields?.workspaceRoot, 'discord:root')
  assertStrictEquals(childFields?.workdir, parentWorkdir)
  assertEquals(childFields?.projectId, 'folder-project-a')
})