import { test } from 'node:test'
import assert from 'node:assert/strict'
import { allowedSubagentModes, type ExecutionMode } from '../sessions/execution-mode.ts'
import '../testing/snapshot.ts'
import { Bus } from '../bus/bus.ts'
import { SessionTools, Tools } from './registry.ts'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { PlanWriteTool } from './plan-write.ts'
import { ExecTool } from './shell.ts'
import { SearchTool } from './search.ts'
import { ImportTool, type LoadableEntry } from './load-tool.ts'
import { InvokeTool } from './invoke-tool.ts'
import { SkillsManager } from '../skills/loader.ts'
import { BackgroundTaskTool, ContinuationTool } from './background.ts'
import { LogTool } from './log.ts'
import { MessageTool } from './message.ts'
import { TopicTool } from './topic.ts'
import { InitiativeTool } from './initiative.ts'
import { INITIATIVE_SCHEMA_PROMPT } from '../initiatives/schema.ts'
import type { TopicService } from '../sessions/topics.ts'
import { SubagentTool } from './subagent.ts'
import { YieldTool } from './yield.ts'
import type { YieldManager } from '../sessions/yield.ts'
import { ConventionTool } from './convention.ts'
import { MemoryStore } from '../agent/memory.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { EventService } from '../events/service.ts'
import { getBuiltinAgentTypes } from '../agent/types/builtins.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { ChannelManager } from '../channels/manager.ts'

/**
 * Pins the tool surface exposed to the LLM.
 *
 * Two layers are snapshotted:
 *  1. The base registry — every always-on tool's exact name, description, and
 *     JSON-schema parameters as sent on the wire. Tool definitions are static
 *     class fields, so this is deterministic.
 *  2. The filtered surface each built-in agent type receives once its
 *     `allowedTools` / `blockedTools` policy (and opt-in hiding) is applied.
 *     This makes it obvious, per agent, which tools are reachable.
 *
 * Heavy collaborators (SessionManager, ChannelManager) are stubbed because only
 * construction — not execution — is exercised here.
 *
 * Lazy tools (MCP servers and chrome-devtools)
 * are loaded on demand. Opt-in tools registered in the base
 * (plan_write, log, initiative) stay hidden unless an agent type
 * whitelists them.
 *
 * Regenerate snapshots after an intentional change with:
 *   pnpm test:update
 */

const WORKSPACE = '/workspace'
const stub = <T>(): T => ({} as unknown as T)

/**
 * Build a base tool registry mirroring the always-on tools registered in
 * `src/runtime/main/project-runtime.ts`, in the same registration order.
 */
function buildBaseTools(): Tools {
  const bus = new Bus()
  const deliver = async (sessionId: string, input: { id: string }) => ({
    status: 'accepted' as const, sessionId, inputId: input.id,
  })
  const events = new EventService(WORKSPACE, bus, deliver)
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const commandHandler = new CommandHandlerManager()
  const processManager = new ProcessManager()

  const tools = new Tools(WORKSPACE)
  tools.register(new ReadTool(WORKSPACE))
  tools.register(new WriteTool(WORKSPACE))
  tools.register(new PlanWriteTool(WORKSPACE))
  tools.register(
    new ExecTool(
      WORKSPACE,
      120_000,
      commandHandler,
      processManager,
      undefined,
      backgroundTasks,
    ),
  )
  const importer = new ImportTool(new Map<string, LoadableEntry>(), WORKSPACE)
  tools.register(new InitiativeTool({ query: () => [] }, 'fixture', INITIATIVE_SCHEMA_PROMPT))
  tools.register(new SearchTool(WORKSPACE))
  tools.register(new InvokeTool(importer))
  tools.register(new BackgroundTaskTool(backgroundTasks))
  tools.register(new ContinuationTool(backgroundTasks))
  tools.register(new LogTool(WORKSPACE))
  tools.register(new TopicTool(stub<TopicService>()))
  tools.register(
    new MessageTool(bus, () => true, () => undefined, () => undefined, deliver),
  )
  tools.register(new YieldTool(stub<YieldManager>()))
  tools.register(
    new SubagentTool(
      bus,
      stub<SessionManager>(),
      stub<AgentTypesManager>(),
      stub<ChannelManager>(),
    ),
  )
  tools.register(new ConventionTool(new MemoryStore(WORKSPACE)))
  return tools
}

test('tools — base tool definitions as sent to the LLM API are pinned', (t) => {
  // Exactly the JSON payload placed in the request body's `tools` field for
  // OpenAI-compatible providers (`body.tools = getDefinitions()`). undefined
  // `optIn` is dropped by JSON.stringify, matching the on-the-wire format.
  const payload = JSON.stringify(buildBaseTools().getDefinitions(), null, 2)
  t.assert.snapshot(payload)
})

test('an explicit empty tool allowlist denies base and dynamically imported tools', () => {
  const base = buildBaseTools()
  const tools = new SessionTools(base, WORKSPACE, [])
  assert.deepEqual(tools.getDefinitions(), [])
  assert.equal(tools.has('read'), false)
  assert.equal(tools.has('exec'), false)
  assert.equal(tools.canUseDynamic('arbitrary_tool'), false)
  assert.deepEqual(tools.snapshot().getDefinitions(), [])
})

test('tools — tool surface per agent type', async (t) => {
  // For each built-in agent type, apply its allow/block policy (plus opt-in
  // hiding) and pin the resulting reachable tool names. Sorted by name so the
  // snapshot order is stable regardless of directory read order.
  const base = buildBaseTools()
  const types = (await getBuiltinAgentTypes())
    .sort((a, b) => a.name.localeCompare(b.name))
  for (const type of types) {
    await t.test(type.name, (st) => {
      const session = new SessionTools(
        base,
        WORKSPACE,
        type.allowedTools,
        type.blockedTools,
      )
      st.assert.snapshot(session.names().join('\n'))
    })
  }
})

test('scoped tool descriptions match the modes advertised to the model', () => {
  const base = buildBaseTools()
  const cases: Array<[ExecutionMode, boolean]> = [
    ['session', false], ['session', true], ['task', true], ['call', true],
  ]
  for (const [mode, parent] of cases) {
    const tools = new SessionTools(base, WORKSPACE)
    const modes = allowedSubagentModes(mode, parent)
    tools.setExecutionScope(mode, modes)
    const definitions = tools.getDefinitions()
    assert.equal(definitions.some(def => def.function.name === 'topic'), mode === 'session')
    const subagent = definitions.find(def => def.function.name === 'subagent')?.function
    if (!modes.length) {
      assert.equal(subagent, undefined)
      for (const name of ['yield', 'message']) {
        assert(!definitions.some(def => def.function.name === name))
      }
      const exec = definitions.find(def => def.function.name === 'exec')!
      assert.doesNotMatch(JSON.stringify(exec), /fire-and-forget|NOT killed|0 = run in background/)
      continue
    }
    assert(subagent)
    assert.deepEqual(subagent.parameters.properties.mode.enum, modes)
    if (!modes.includes('call')) {
      assert.doesNotMatch(JSON.stringify(subagent), /\bcall\b|blocking|leaf/)
    } else {
      assert.match(subagent.description, /blocking bounded leaf call/)
      assert.equal(subagent.parameters.required?.includes('mode') ?? false, !modes.includes('task'))
      assert(subagent.parameters.required?.includes('task'))
      assert.doesNotMatch(subagent.parameters.properties.task.description!, /optional/)
    }
    if (mode === 'task') assert(!('report_to' in subagent.parameters.properties))
  }
  assert.deepEqual(base.get('subagent')!.parameters.properties.mode.enum, ['task', 'call'])
})
