import assert, { deepEqual, equal } from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import type { LlmRuntimeConfig } from '../agent/llm-config.ts'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import type {
  ChatMessage,
  LLMProvider,
  LLMResponse,
  ResponsesProviderState,
} from '../providers/provider.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { BaseSession } from './base-session.ts'
import { EphemeralSession } from './ephemeral-session.ts'
import { channelMessageInput } from './input.ts'
import {
  SessionManager,
  type SessionManagerDeps,
} from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'

const llm: LlmRuntimeConfig = {
  model: 'gpt-6-astra',
  contextWindow: 128_000,
  temperature: 0,
}
const timestamp = '2026-09-10T08:00:00.000Z'
const toolCall: NonNullable<ChatMessage['tool_calls']>[number] = {
  id: 'call_synthetic_1',
  type: 'function',
  function: { name: 'fixture_echo', arguments: '{"text":"tool result"}' },
}
const usage = { promptTokens: 42, completionTokens: 12, totalTokens: 54 }

function providerState(suffix: string): ResponsesProviderState {
  const reasoning: ResponsesProviderState['reasoning'] = [{
    type: 'reasoning',
    id: `rs_synthetic_${suffix}`,
    encrypted_content: `synthetic-encrypted-${suffix}`,
    summary: [{ type: 'summary_text', text: `Summary ${suffix}` }],
  }]
  return {
    provider: 'copilot',
    model: llm.model,
    reasoning,
    outputItems: [
      ...reasoning,
      {
        type: 'message',
        id: `msg_synthetic_${suffix}`,
        role: 'assistant',
        status: 'completed',
        phase: suffix === 'final' ? 'final_answer' : 'commentary',
        content: [{
          type: 'output_text',
          text: suffix === 'final' ? 'Finished' : 'Running fixture tool',
          annotations: [],
        }],
      },
      ...(suffix === 'final' ? [] : [{
        type: 'function_call' as const,
        id: `fc_synthetic_${suffix}`,
        status: 'completed' as const,
        call_id: toolCall.id,
        name: toolCall.function.name,
        arguments: toolCall.function.arguments,
      }]),
    ],
  }
}

function inbound(content: string): InboundMessage {
  return {
    channel: 'test',
    chatId: 'continuity',
    senderId: 'fixture-user',
    messageId: 'fixture-message',
    content,
    timestamp,
  }
}

function scriptedProvider(responses: LLMResponse[]) {
  const requests: ChatMessage[][] = []
  const provider: LLMProvider = {
    name: 'copilot',
    listModels: () => [llm.model],
    chat: async (messages) => {
      requests.push(structuredClone(messages))
      const response = responses[requests.length - 1]
      assert(response, 'unexpected provider call')
      return response
    },
  }
  return { provider, requests }
}

function historyManager(
  workspace: string,
  store: SessionStore,
  provider: LLMProvider,
): SessionManager {
  return new SessionManager({
    workspace,
    store,
    provider,
    bus: new Bus(),
    tools: new Tools(workspace),
    context: { buildSystemPrompt: async () => 'Synthetic system prompt' },
    agentTypes: {
      resolve: () => ({
        name: 'fixture',
        description: 'Fixture agent',
        prompt: '',
        ephemeral: true,
        source: 'builtin',
      }),
    },
  } as unknown as SessionManagerDeps)
}

class AppendSession extends BaseSession {
  persist(...messages: ChatMessage[]): Promise<void> {
    return this.appendMessages(llm, ...messages)
  }
}

const stores = [
  ['JSONL', (directory: string): SessionStore => new JsonlSessionStore(directory)],
  ['SQLite', (directory: string): SessionStore => new SqliteSessionStore(directory)],
] as const

for (const [name, createStore] of stores) {
  test(`${name}: Responses continuity survives the tool loop, persistence, and resumed context`, async () => {
    await mkdir('.test-data', { recursive: true })
    const workspace = await mkdtemp(join(process.cwd(), '.test-data', 'provider-state-'))
    const directory = join(workspace, 'sessions')
    let store = createStore(directory)
    let manager: SessionManager | undefined
    try {
      await store.init()
      const state: SessionState = {
        sessionId: 'test:continuity',
        segmentIndex: 3,
        lastKnownTokens: 123,
        config: { model: llm.model },
        workspaceRoot: 'test:root',
        children: ['test:child'],
      }
      const physicalId = SessionManager.currentPhysicalId(state)
      await store.saveState(state.sessionId, state)
      await store.createSessionLog(physicalId, [
        { previous_physical_id: 'test_continuity-2', timestamp },
        { role: 'assistant', content: 'Legacy reply', timestamp },
      ])
      const toolState = providerState('tool')
      const finalState = providerState('final')
      const { provider, requests } = scriptedProvider([
        {
          content: null,
          reasoningText: 'Display-only narration',
          providerState: toolState,
          toolCalls: [{
            id: toolCall.id,
            name: toolCall.function.name,
            arguments: { text: 'tool result' },
          }],
          usage,
        },
        { content: 'Finished', providerState: finalState, toolCalls: [] },
      ])
      const tools = new Tools(workspace)
      tools.register({
        name: toolCall.function.name,
        description: 'Synthetic echo tool',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (args) => String(args.text),
      })
      const session = new EphemeralSession(
        workspace,
        state.sessionId,
        state,
        [
          { role: 'system', content: 'Synthetic system prompt' },
          { role: 'assistant', content: 'Legacy reply' },
        ],
        provider,
        new SessionTools(tools, workspace),
        new Bus(),
        store,
      )
      session.dispatch(channelMessageInput(inbound('Use the fixture tool')), llm)
      await session.completion

      equal(requests.length, 2)
      deepEqual(requests[1].at(-2)?.provider_state, toolState)
      deepEqual(requests[1].at(-2)?.tool_calls, [toolCall])
      equal(requests[1].at(-2)?.reasoning_text, 'Display-only narration')
      deepEqual(requests[1].at(-1), {
        role: 'tool',
        content: 'tool result',
        tool_call_id: toolCall.id,
        name: toolCall.function.name,
      })
      deepEqual(session.history.at(-1)?.provider_state, finalState)
      equal(session.physicalSessionId, physicalId)

      store.close?.()
      store = createStore(directory)
      await store.init()
      deepEqual(await store.getState(state.sessionId), state)
      const records = await Array.fromAsync(store.readSessionLog(physicalId))
      equal(records.length, 6)
      deepEqual(records[3].provider_state, toolState)
      deepEqual(records[3].tool_calls, [toolCall])
      deepEqual(records[3].usage, usage)
      equal(records[4].tool_call_id, toolCall.id)
      deepEqual(records[5].provider_state, finalState)
      for (const record of records.filter((record) => record.role !== 'assistant')) {
        equal(Object.hasOwn(record, 'provider_state'), false)
      }
      equal(Object.hasOwn(records[1], 'provider_state'), false)

      const resumed = scriptedProvider([{ content: 'Resumed', toolCalls: [] }])
      manager = historyManager(workspace, store, resumed.provider)
      await manager.start()
      for (const query of [undefined, { shallow: true }, { physicalId }]) {
        const { messages } = await manager.getHistory(state.sessionId, query)
        equal(messages.length, 5)
        equal(messages[0].provider_state, undefined)
        deepEqual(messages[2].provider_state, toolState)
        deepEqual(messages[2].tool_calls, [toolCall])
        deepEqual(messages[2].usage, usage)
        equal(messages[3].tool_call_id, toolCall.id)
        deepEqual(messages[4].provider_state, finalState)
      }
      await manager.dispatch(inbound('Continue after restart'), llm)
      await manager.getActiveSession(state.sessionId)?.completion
      equal(resumed.requests.length, 1)
      const restoredContext = resumed.requests[0]
      equal(restoredContext[0].role, 'system')
      deepEqual(restoredContext[3].provider_state, toolState)
      deepEqual(restoredContext[3].tool_calls, [toolCall])
      equal(restoredContext[4].tool_call_id, toolCall.id)
      deepEqual(restoredContext[5].provider_state, finalState)
      const updated = await Array.fromAsync(store.readSessionLog(physicalId))
      equal(updated.length, 8)
      equal(Object.hasOwn(updated.at(-1)!, 'provider_state'), false)
      equal((await store.getState(state.sessionId))?.segmentIndex, 3)
    } finally {
      await manager?.stop()
      store.close?.()
      await rm(workspace, { recursive: true, force: true })
    }
  })

  test(`${name}: provider state is assistant-only when saving and restoring inherited history`, async () => {
    await mkdir('.test-data', { recursive: true })
    const workspace = await mkdtemp(join(process.cwd(), '.test-data', 'provider-state-'))
    let store = createStore(join(workspace, 'sessions'))
    let manager: SessionManager | undefined
    try {
      await store.init()
      const state: SessionState = { sessionId: 'test:parent', segmentIndex: 2 }
      const physicalId = SessionManager.currentPhysicalId(state)
      const continuation = providerState('inherited')
      await store.createSessionLog(physicalId, [
        { previous_physical_id: null, timestamp },
      ])
      const { provider } = scriptedProvider([])
      const session = new AppendSession(
        workspace,
        state.sessionId,
        state,
        [],
        provider,
        new SessionTools(new Tools(workspace), workspace),
        new Bus(),
        store,
      )
      await session.persist(
        { role: 'system', content: 'System', provider_state: continuation },
        { role: 'user', content: 'User', provider_state: continuation },
        {
          role: 'assistant',
          content: null,
          provider_state: continuation,
          tool_calls: [toolCall],
        },
        {
          role: 'tool',
          content: 'Result',
          tool_call_id: toolCall.id,
          provider_state: continuation,
        },
        { role: 'assistant', content: 'Legacy reply' },
      )
      const records = await Array.fromAsync(store.readSessionLog(physicalId))
      deepEqual(records[3].provider_state, continuation)
      for (const index of [1, 2, 4, 5]) {
        equal(Object.hasOwn(records[index], 'provider_state'), false)
      }

      // External/old logs must not promote non-assistant metadata into context.
      await store.appendRawEvents(physicalId, [
        { role: 'system', content: 'Injected system', provider_state: continuation },
        { role: 'user', content: 'Injected user', provider_state: continuation },
        {
          role: 'tool',
          content: 'Injected result',
          tool_call_id: toolCall.id,
          provider_state: continuation,
        },
      ])
      const childState: SessionState = {
        sessionId: 'test:child',
        segmentIndex: 0,
        lastActivityAt: timestamp,
        lastKnownTokens: 0,
        parent: { id: state.sessionId, physicalId, index: 4 },
        workspaceRoot: state.sessionId,
      }
      await store.saveState(childState.sessionId, childState)
      const childPhysicalId = SessionManager.currentPhysicalId(childState)
      await store.createSessionLog(childPhysicalId, [
        { previous_physical_id: null, timestamp },
        { role: 'user', content: 'Fork continuation', timestamp },
      ])
      store.close?.()
      store = createStore(join(workspace, 'sessions'))
      await store.init()
      manager = historyManager(workspace, store, provider)
      await manager.start()
      const parent = await manager.getHistory(state.sessionId)
      const assistants = parent.messages.filter((message) => message.role === 'assistant')
      deepEqual(assistants[0].provider_state, continuation)
      equal(assistants[1].provider_state, undefined)
      for (const message of parent.messages.filter((message) => message.role !== 'assistant')) {
        equal(message.provider_state, undefined)
      }
      const child = await manager.getHistory(childState.sessionId)
      deepEqual(child.messages.map((message) => message.role), [
        'system', 'user', 'assistant', 'tool', 'user',
      ])
      deepEqual(child.messages[2].provider_state, continuation)
      deepEqual(child.messages[2].tool_calls, [toolCall])
      equal(child.messages[3].tool_call_id, toolCall.id)
      const truncated = await manager.getHistory(childState.sessionId, { maxMessages: 3 })
      deepEqual(truncated.messages[0].provider_state, continuation)
      equal(truncated.messages[1].tool_call_id, toolCall.id)
      const boundary = await manager.getHistory(childState.sessionId, { maxMessages: 2 })
      deepEqual(boundary.messages.map((message) => message.role), ['user'])
      const shallow = await manager.getHistory(childState.sessionId, { shallow: true })
      equal(shallow.messages.length, 1)
      equal(shallow.messages[0].provider_state, undefined)
      deepEqual(await store.getState(childState.sessionId), childState)
    } finally {
      await manager?.stop()
      store.close?.()
      await rm(workspace, { recursive: true, force: true })
    }
  })
}
