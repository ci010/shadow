import { deepEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import type { AgentTypesManager } from '../agent/agent-types/manager.ts'
import type { Bus } from '../bus/bus.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { SubagentTool } from './subagent.ts'
import type { ExecutionMode } from '../sessions/execution-mode.ts'

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
    assertCanCreateChild: () => {},
    getAllowedSubagentModes: () => ['session', 'task'],
    getSessionState: () => parentState,
    executeOnce: (_key: string, run: () => Promise<string>) => run(),
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
      defaultMode: 'session',
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

test('only reusable sessions create native threads; no-thread external children are virtual', async () => {
  for (const mode of ['session', 'task', 'call'] as const) {
    for (const native of [true, false]) {
      let threadCalls = 0
      let createdId = ''
      const parentState: SessionState = { sessionId: 'discord:root', segmentIndex: 0 }
      const sessions = {
        assertCanCreateChild: () => {},
        getAllowedSubagentModes: (): ExecutionMode[] => ['session', 'task', 'call'],
        getSessionState: () => parentState,
        executeOnce: (_key: string, run: () => Promise<string>) => run(),
        buildSession: async (id: string) => { createdId = id },
        addChild: async () => {},
        startChild: async () => ({ status: 'accepted' }),
        startCall: async () => 'Call result',
      } as unknown as SessionManager
      const agentTypes = {
        resolve: () => ({ name: 'sub', description: '', prompt: '', defaultMode: 'session', source: 'builtin' }),
        allNames: () => ['sub'],
      } as unknown as AgentTypesManager
      const channels = {
        createThread: async () => { threadCalls++; return native ? 'native-thread' : null },
      } as unknown as ChannelManager
      const tool = new SubagentTool({} as Bus, sessions, agentTypes, channels)
      await tool.execute({ mode, task: 'Bounded work', description: 'Child' }, {
        channel: 'discord', chatId: 'root', senderId: 'alice', messageId: 'input',
        sessionId: 'discord:root', physicalSessionId: 'discord_root-0',
      } as ExecutionContext)
      assertEquals(threadCalls, mode === 'session' ? 1 : 0)
      assertEquals(createdId.startsWith('discord:'), mode === 'session' && native)
      assertEquals(createdId.startsWith('virtual:'), mode !== 'session' || !native)
    }
  }
})