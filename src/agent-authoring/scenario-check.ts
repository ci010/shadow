import type { AuthoringEvaluationResult } from '../sessions/authoring-evaluation.ts'
import { inferenceSettings, type LlmRuntimeConfig } from '../agent/llm-config.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { contentText } from '../providers/provider.ts'
import type { ResolvedConversationPolicy } from './contracts.ts'
import { type AgentAuthoringService, validateToolArguments } from './service.ts'

export interface AuthoringScenario {
  input: string
  /** Each alias has a repeatable JSON receipt or { sequence: [receipt, ...] }. */
  toolResults: Record<string, unknown>
  expectedTools?: string[]
  forbiddenTools?: string[]
  responseIncludes?: string[]
  responseExcludes?: string[]
}

export interface ScenarioToolCall {
  name: string
  args: Record<string, unknown>
  result?: unknown
  error?: string
}

export interface ScenarioCheck {
  kind: 'expectedTool' | 'forbiddenTool' | 'responseIncludes' | 'responseExcludes'
  expected: string
  passed: boolean
}

export interface AuthoringScenarioResult extends Omit<AuthoringEvaluationResult, 'status'> {
  status: 'completed' | 'failed' | 'passed'
  executionStatus: AuthoringEvaluationResult['status']
  response: string
  toolCalls: ScenarioToolCall[]
  checks: ScenarioCheck[]
}

export type AuthoringScenarioLlmOverrides = Partial<Pick<LlmRuntimeConfig,
  'model' | 'temperature' | 'maxTokens' | 'thinking' | 'reasoningEffort'>>

export interface AuthoringScenarioOptions {
  service: AgentAuthoringService
  policy: ResolvedConversationPolicy
  signal: AbortSignal
  scenario: AuthoringScenario
  evaluate: (
    prompt: string, tools: SessionTools, input: string, signal: AbortSignal,
    llmOverrides?: AuthoringScenarioLlmOverrides,
  ) => Promise<AuthoringEvaluationResult>
}

function validateScenario(scenario: AuthoringScenario): void {
  if (typeof scenario.input !== 'string' || !scenario.input.trim() ||
    Buffer.byteLength(scenario.input, 'utf8') > 32 * 1024) {
    throw new Error('Scenario input must be nonempty and at most 32 KiB.')
  }
  if (!scenario.toolResults || typeof scenario.toolResults !== 'object' || Array.isArray(scenario.toolResults) ||
    Object.keys(scenario.toolResults).length > 64) throw new Error('Scenario requires at most 64 tool fixtures.')
  const encoded = JSON.stringify(scenario.toolResults, (_key, value: unknown) => {
    if (value === undefined || typeof value === 'function' || typeof value === 'symbol' ||
      typeof value === 'bigint' || (typeof value === 'number' && !Number.isFinite(value))) {
      throw new Error('Scenario fixtures must contain only JSON values.')
    }
    return value
  })
  if (Buffer.byteLength(encoded, 'utf8') > 256 * 1024) throw new Error('Scenario fixtures exceed 256 KiB.')
  for (const [name, value] of Object.entries(scenario.toolResults)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'sequence')) {
      const sequence = (value as { sequence: unknown }).sequence
      if (Object.keys(value).length !== 1 || !Array.isArray(sequence) || !sequence.length || sequence.length > 128) {
        throw new Error(`Tool fixture "${name}" requires a nonempty sequence of at most 128 receipts.`)
      }
    }
  }
  for (const values of [scenario.expectedTools, scenario.forbiddenTools, scenario.responseIncludes, scenario.responseExcludes]) {
    if (values !== undefined && (!Array.isArray(values) || values.length > 64 ||
      values.some(value => typeof value !== 'string' || !value.length || value.length > 4096))) {
      throw new Error('Scenario assertions require at most 64 nonempty strings of at most 4096 characters.')
    }
  }
}

/** All tool aliases, including read/search, are fixtures. No authored implementation runs. */
export async function runAuthoringScenario(options: AuthoringScenarioOptions): Promise<AuthoringScenarioResult> {
  validateScenario(options.scenario)
  const scenario = structuredClone(options.scenario)
  const { service, policy, signal } = options
  const prompt = service.prompt(policy, '(preview)').systemPrompt
  const definitions = service.tools(policy, '(preview)').getDefinitions()
  const schemas = new Map(definitions.map(definition => [definition.function.name, definition.function.parameters]))
  const positions = new Map<string, number>()
  const toolCalls: ScenarioToolCall[] = []
  // Override registry execution so thrown fixture failures stay terminal and
  // large receipts never enter Tools' filesystem-backed truncation path.
  class FixtureTools extends SessionTools {
    override async execute(name: string, args: Record<string, unknown>, context: ExecutionContext): Promise<string> {
      const call: ScenarioToolCall = { name, args: structuredClone(args) }
      toolCalls.push(call)
      try {
        context.signal.throwIfAborted()
        if (toolCalls.length > 128) throw new Error('Scenario exceeded 128 tool invocations.')
        const schema = schemas.get(name)
        if (!schema) throw new Error(`Unknown scenario tool "${name}".`)
        validateToolArguments(schema, args)
        if (!Object.hasOwn(scenario.toolResults, name)) throw new Error(`Missing synthetic receipt for tool "${name}".`)
        const fixture = scenario.toolResults[name]
        let receipt = fixture
        if (fixture && typeof fixture === 'object' && !Array.isArray(fixture) && Object.hasOwn(fixture, 'sequence')) {
          const sequence = (fixture as { sequence: unknown[] }).sequence
          const position = positions.get(name) ?? 0
          if (position >= sequence.length) throw new Error(`Synthetic receipts exhausted for tool "${name}".`)
          positions.set(name, position + 1)
          receipt = sequence[position]
        }
        call.result = structuredClone(receipt)
        return typeof call.result === 'string' ? call.result : JSON.stringify(call.result)
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error)
        throw error
      }
    }
  }
  const base = new Tools(service.options.workspace)
  for (const definition of definitions) base.register({
    name: definition.function.name, description: definition.function.description,
    parameters: definition.function.parameters, optIn: definition.optIn,
    execute: async () => { throw new Error('Synthetic tools must use the scenario registry.') },
  })
  const tools = new FixtureTools(base, service.options.workspace, definitions.map(definition => definition.function.name), [], [])
  const llmOverrides = inferenceSettings(policy.agent)
  let evaluation: AuthoringEvaluationResult
  try {
    evaluation = await options.evaluate(prompt, tools, scenario.input, signal, llmOverrides)
  } finally {
    tools.resetDynamic()
  }
  const response = evaluation.result?.content ?? [...evaluation.messages].reverse()
    .filter(message => message.role === 'assistant' && !message.tool_calls?.length)
    .map(message => contentText(message.content))[0] ?? ''
  const called = new Set(toolCalls.map(call => call.name))
  const checks: ScenarioCheck[] = [
    ...(scenario.expectedTools ?? []).map(expected => ({ kind: 'expectedTool' as const, expected, passed: called.has(expected) })),
    ...(scenario.forbiddenTools ?? []).map(expected => ({ kind: 'forbiddenTool' as const, expected, passed: !called.has(expected) })),
    ...(scenario.responseIncludes ?? []).map(expected => ({ kind: 'responseIncludes' as const, expected, passed: response.includes(expected) })),
    ...(scenario.responseExcludes ?? []).map(expected => ({ kind: 'responseExcludes' as const, expected, passed: !response.includes(expected) })),
  ]
  const failedTool = toolCalls.find(call => call.error)
  const status = evaluation.status !== 'completed' ? 'failed'
    : failedTool || checks.some(check => !check.passed) ? 'failed'
    : checks.length && evaluation.llmExecuted ? 'passed' : 'completed'
  const error = evaluation.error ?? failedTool?.error ??
    (evaluation.status === 'cancelled' ? 'Scenario evaluation cancelled.'
      : evaluation.status === 'failed' ? 'Scenario evaluation failed.' : undefined)
  return { ...evaluation, status, executionStatus: evaluation.status, response, toolCalls, checks, error }
}
