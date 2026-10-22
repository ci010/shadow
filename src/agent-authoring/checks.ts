import { createHash } from 'node:crypto'
import type { ResolvedConversationPolicy } from './contracts.ts'
import { validateToolArguments } from './service.ts'
import { authoredScriptOptions } from './tool-runtime.ts'
import { executeScript } from '../script-runtime/runtime.ts'
import { evaluateScriptCases } from '../script-runtime/evaluate.ts'
import { createMockResponder, validateMockResult } from './mock-results.ts'

export interface ResourceToolTest {
  toolName: string
  arguments: Record<string, unknown>
  capabilityResults?: Record<string, unknown>
  assertion?: { expected?: unknown }
}

export async function testResourceTool(policy: ResolvedConversationPolicy, input: ResourceToolTest, signal: AbortSignal) {
  const tool = policy.tools.find(tool => tool.name === input.toolName)
  if (!tool || !policy.agent.allowedTools?.includes(tool.name)) throw new Error('Choose a selected, allowed tool alias for testing.')
  validateToolArguments(tool.parameters, input.arguments)
  const calls: Array<{ name: string; input: Record<string, unknown> }> = []
  const mocks = input.capabilityResults ?? {}
  for (const [name, result] of Object.entries(mocks)) {
    const grant = policy.binding.grants.find(grant => grant.id === name)
    if (!grant || !tool.imports.includes(`@shadow/${name}`)) throw new Error(`No imported grant for synthetic result: ${name}`)
    validateMockResult(grant.kind, result)
  }
  const respond = createMockResponder(mocks)
  if (input.assertion && !Object.hasOwn(input.assertion, 'expected')) throw new Error('An assertion requires explicit expected JSON output.')
  const { args, callModule, ...execution } = authoredScriptOptions({
    code: tool.code, args: input.arguments, signal, filename: tool.source,
    imports: tool.imports, allowedModules: policy.agent.allowedModules, mode: 'test',
    callModule: async (name, input, signal) => {
      signal.throwIfAborted()
      if (!tool.imports.includes(`@shadow/${name}`) || !policy.binding.grants.some(grant => grant.id === name)) {
        throw new Error('Tool requested an undeclared or ungranted module.')
      }
      calls.push({ name, input })
      return respond(name)
    },
  })
  const evaluation = input.assertion
    ? await evaluateScriptCases(execution, [{ name: tool.name, args, expected: input.assertion.expected, callModule }])
    : undefined
  const result = evaluation ? evaluation.cases[0].actual : (await executeScript({ ...execution, args, callModule })).value
  return {
    revision: policy.revision, source: tool.source, toolName: tool.name, synthetic: true,
    sourceHash: `sha256:${createHash('sha256').update(tool.code).digest('hex')}`,
    policy: { kind: 'restricted', mode: 'test', imports: tool.imports, allowedModules: policy.agent.allowedModules ?? [] },
    result, calls,
    ...(evaluation ? { evaluation: { ...evaluation.cases[0], expected: input.assertion!.expected } } : {}),
  }
}
