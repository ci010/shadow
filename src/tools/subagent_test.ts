import { deepEqual as assertEquals, strictEqual as assertStrictEquals } from 'node:assert/strict'
import { test } from 'node:test'
import type { ExecutionContext } from './context.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { Bus } from '../bus/bus.ts'
import type { ChannelManager } from '../channels/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { SubagentTool } from './subagent.ts'
import type { ExecutionMode } from '../sessions/execution-mode.ts'
import { channelSessionId, type ChannelAddress } from '../bus/events.ts'
import { SessionTools, Tools } from './registry.ts'
import { rejects } from 'node:assert/strict'

test('nested subagent inherits explicit workdir and legacy workspace root', async () => {
  const parentWorkdir = {
    version: 1 as const,
    nodeId: 'node-a',
    capabilityId: 'folder-a',
  }
  const parentState: SessionState = {
    sessionId: 'discord:parent',
    segmentIndex: 3,
    workspaceRoot: 'discord:root',
    workdir: parentWorkdir,
    folderId: 'folder-folder-a',
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
  assertEquals(childFields?.folderId, 'folder-folder-a')
})

test('native child threads preserve source bot identity and reject unavailable source instead of fallback', async () => {
  const created: string[] = []
  const addresses: Array<ChannelAddress | undefined> = []
  let unavailable = false
  let parentId = ''
  const sessions: Pick<SessionManager, 'assertCanCreateChild' | 'getAllowedSubagentModes' | 'getSessionState' | 'executeOnce' | 'buildSession' | 'addChild'> = {
    assertCanCreateChild: () => {},
    getAllowedSubagentModes: () => ['session'],
    getSessionState: () => ({ sessionId: parentId, segmentIndex: 0, projectId: 'org' }),
    executeOnce: (_key, run) => run(),
    buildSession: async id => { created.push(id) },
    addChild: async () => {},
  }
  const agentTypes: Pick<AgentTypesManager, 'resolve' | 'allNames'> = {
    resolve: () => ({ name: 'sub', description: '', prompt: '', defaultMode: 'session', source: 'builtin' }),
    allNames: () => ['sub'],
  }
  const channels: Pick<ChannelManager, 'createThread'> = {
    createThread: async (_channel, _chat, _name, address) => {
      addresses.push(address)
      if (unavailable) throw new Error('Source bot unavailable')
      return 'same-thread'
    },
  }
  const tool = new SubagentTool({} as Bus, sessions as SessionManager, agentTypes as AgentTypesManager, channels as ChannelManager)
  for (const botInstanceId of ['bot-a', 'bot-b']) {
    const address = { projectId: 'org', botInstanceId, platform: 'discord', conversationId: 'same-parent' }
    parentId = channelSessionId(address)
    const ctx: ExecutionContext = {
      projectId: 'org', channelAddress: address, sessionId: parentId, physicalSessionId: 'physical',
      channel: 'discord', chatId: 'same-parent', senderId: 'alice', messageId: 'input',
      signal: new AbortController().signal, tools: new SessionTools(new Tools('.'), '.'),
    }
    await tool.execute({ description: 'Child' }, ctx)
    assertEquals(addresses.at(-1), address)
    assertEquals(created.at(-1), channelSessionId({ ...address, conversationId: 'same-thread' }))
    unavailable = true
    const count = created.length
    await rejects(tool.execute({ description: 'Unavailable' }, { ...ctx, channelAddress: undefined }), /Source bot unavailable/)
    assertEquals(created.length, count)
    unavailable = false
  }
  assertStrictEquals(new Set(created).size, 2)
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