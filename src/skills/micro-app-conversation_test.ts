import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { SendMessageRequest, Task, TaskState } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { acceptanceMessage } from '../../scripts/microapp-a2a.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { executionContractProvider, guidelineProvider } from '../agent/context/guideline.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { Tools } from '../tools/registry.ts'
import { AskTool } from '../tools/ask.ts'
import { A2aConfigSchema } from '../a2a/config.ts'
import { A2aStore } from '../a2a/store.ts'
import { A2aService } from '../a2a/service.ts'
import { sessionA2aRunner } from '../a2a/runtime.ts'

const goal = '我想在 VRChat 里输入中文，让别人听到日语，同时把别人说的话翻译成中文字幕。帮我做成一个能反复打开使用的小工具。'
const question = '对方通常说什么语言？'
const answer = '主要是日语和英语，不保存字幕。可以开始。'
const feedback = '保留两个方向，界面简单一些。'

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`guided app context survives input and feedback without granting authority (${storage})`, { timeout: 15_000 }, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = storage === 'jsonl'
        ? new JsonlSessionStore(join(workspace, '.sessions'))
        : new SqliteSessionStore(join(workspace, '.sessions'))
      await store.init()
      const agentTypes = new AgentTypesManager(workspace)
      await agentTypes.load()
      const resolve = agentTypes.resolve.bind(agentTypes)
      const general = resolve('general')!
      t.mock.method(agentTypes, 'resolve', (name: string) => name === 'guided-fixture'
        ? { ...general, name: 'guided-fixture', allowedTools: ['read', 'ask'], soul: false } : resolve(name))
      const skills = new SkillsManager(workspace)
      await skills.load()
      let calls = 0
      // This provider verifies real context/continuation plumbing, not LLM judgment or app construction.
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => [],
        async chat(messages, tools) {
          const system = messages.filter(message => message.role === 'system').map(message => String(message.content)).join('\n')
          assert.match(system, /v:skills\/micro-app` for guided builds/)
          assert.match(system, /v:skills\/micro-app/)
          assert.match(system, /A reply is not approval for protected actions/)
          assert.deepEqual(tools.map(tool => tool.function.name).sort(), ['ask', 'read'])
          const users = messages.filter(message => message.role === 'user').map(message => JSON.stringify(message.content)).join('\n')
          assert.ok(users.includes(goal), 'The short original goal is retained')
          assert.doesNotMatch(users, /WASAPI|Silero|26200|1040/, 'No full engineering specification is appended to the user message')
          const results = messages.filter(message => message.role === 'tool')
          switch (calls++) {
            case 0:
              return { content: '', toolCalls: [{ id: 'read-app-guide', name: 'read', arguments: { path: 'v:skills/micro-app' } }] }
            case 1:
              assert.match(String(results.at(-1)?.content), /From a short goal to a working app/)
              return { content: '', toolCalls: [{ id: 'ask-source-language', name: 'ask', arguments: { kind: 'input', question } }] }
            case 2: {
              const receipt = JSON.parse(String(results.at(-1)?.content))
              assert.equal(receipt.text, answer)
              assert.equal('approved' in receipt, false, 'Ordinary A2A input is not a permission receipt')
              return { content: '', toolCalls: [{ id: 'denied-local-decision', name: 'ask', arguments: {
                kind: 'decision', question: 'Approve execution?', options: ['Approve', 'Defer'], default_option: 'Defer',
              } }] }
            }
            case 3:
              assert.match(String(results.at(-1)?.content), /not a local human decision authority/)
              return { content: 'Fixture: inputs retained; construction and owner review are still pending.', toolCalls: [] }
            case 4:
              assert.ok(users.includes(feedback))
              assert.ok(results.some(message => String(message.content).includes(answer)), 'Earlier answers survive the next user turn')
              assert.ok(results.some(message => String(message.content).includes('retain earlier answers, constraints and verified behavior')))
              return { content: 'Fixture: feedback retained without re-asking or assuming approval.', toolCalls: [] }
            default:
              throw new Error('Unexpected model turn')
          }
        },
      }
      const bus = new Bus()
      const events = new EventService(workspace, bus, async () => { throw new Error('Unexpected event delivery') })
      const backgroundTasks = new BackgroundTaskManager(bus, events)
      const handoffManager = new HandoffManager(provider, 100000, {}, workspace, store)
      const context = new ContextBuilder(workspace)
      context.register(executionContractProvider())
      context.register(guidelineProvider())
      const tools = new Tools(workspace)
      tools.register({
        name: 'read', readonly: true, description: 'Read the real built-in app skill in this fixture.',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        async execute(args) {
          assert.deepEqual(args, { path: 'v:skills/micro-app' })
          const body = skills.getSkillBody('micro-app')
          assert.ok(body)
          return body
        },
      })
      const sessions = new SessionManager({
        projectId: 'guided-test', workspace, store, bus, provider, events, backgroundTasks, handoffManager, agentTypes,
        identity: new IdentityManager(workspace), context, tools,
        getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 100000 }),
      })
      tools.register(new AskTool(sessions.yields, sessions.inputs))
      const tasks = new A2aStore(join(workspace, '.a2a'))
      tasks.init()
      const server = A2aConfigSchema.parse({ server: {
        url: 'http://127.0.0.1/projects/guided-test/a2a', agentType: 'guided-fixture', callers: { tester: 'TOKEN' },
      } }).server!
      const service = new A2aService('guided-test', server, tasks, sessionA2aRunner(sessions, bus, agentTypes, 'guided-fixture'))
      const caller = new ServerCallContext({ user: { isAuthenticated: true, userName: 'tester' }, requestedVersion: '1.0' })
      try {
        await sessions.start()
        const initial = acceptanceMessage(goal)
        const waiting = await service.sendMessage(SendMessageRequest.fromJSON({ message: initial.message }), caller)
        assert.equal(waiting.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
        assert.equal(waiting.status.message?.parts[0].content?.value, question)
        assert.equal(calls, 2, 'The agent really waits; no background construction is running')
        const reply = acceptanceMessage(answer, Task.toJSON(waiting))
        assert.equal(reply.kind, 'answer')
        const completed = await service.sendMessage(SendMessageRequest.fromJSON({ message: reply.message }), caller)
        assert.equal(completed.id, waiting.id)
        assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED)
        const followup = acceptanceMessage(feedback, Task.toJSON(completed))
        assert.equal(followup.kind, 'followup')
        const next = await service.sendMessage(SendMessageRequest.fromJSON({ message: followup.message }), caller)
        assert.notEqual(next.id, completed.id)
        assert.equal(next.contextId, completed.contextId)
        assert.equal(next.status?.state, TaskState.TASK_STATE_COMPLETED)
        assert.equal(calls, 5)
        const sessionId = tasks.inbound.get(waiting.id)!.sessionId
        assert.equal(tasks.inbound.get(next.id)!.sessionId, sessionId)
        assert.equal(sessions.inputs.get(sessionId), null)
        assert.equal(sessions.yields.get(sessionId), null)
        const state = sessions.getSessionState(sessionId)!
        const records = []
        for await (const row of store.readSessionLog(SessionManager.currentPhysicalId(state))) {
          if (row.input_request) records.push(row.input_request)
        }
        assert.equal(records.length, 2, 'Both request and answer are persisted')
        assert.partialDeepStrictEqual(records[1], { answer: { text: answer, answeredBy: 'caller' } })
        const history = await sessions.getHistory(sessionId, { shallow: true })
        for (const id of ['read-app-guide', 'ask-source-language', 'denied-local-decision']) {
          assert.equal(history.messages.filter(message => message.role === 'tool' && message.tool_call_id === id).length, 1)
        }
      } finally {
        await service.close()
        await sessions.stop()
        await handoffManager.stop()
        await backgroundTasks.stop()
        await events.stop()
        await skills.stopWatching()
        await agentTypes.stopWatching()
        bus.stopAll()
        await store.close?.()
      }
    })
  })
}
