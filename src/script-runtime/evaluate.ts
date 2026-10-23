import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { encodeJson } from './json-boundary.ts'
import { executeScript, type ScriptOptions } from './runtime.ts'

export interface ScriptCase {
  name: string
  args: unknown
  expected: unknown
  callModule?: ScriptOptions['callModule']
}

export interface ScriptCaseResult {
  name: string
  passed: boolean
  actual?: unknown
  error?: string
}

/** Evaluation changes the inputs and module bindings, never the execution engine. */
export async function evaluateScriptCases(
  options: Omit<ScriptOptions, 'args' | 'callModule'>,
  cases: readonly ScriptCase[],
): Promise<{ sourceHash: string; policy: ScriptOptions['policy']; passed: boolean; cases: ScriptCaseResult[] }> {
  if (!cases.length) throw new TypeError('At least one script evaluation case is required.')
  for (const scenario of cases) {
    if (!scenario.name.trim() || !Object.hasOwn(scenario, 'expected')) {
      throw new TypeError('Each script case requires a name and explicit expected JSON value.')
    }
    encodeJson(scenario.expected, 'expected value')
    encodeJson(scenario.args, 'case input')
  }
  const results: ScriptCaseResult[] = []
  for (const scenario of cases) {
    options.signal.throwIfAborted()
    try {
      const result = await executeScript({ ...options, args: scenario.args, callModule: scenario.callModule })
      results.push({ name: scenario.name, passed: isDeepStrictEqual(result.value, scenario.expected), actual: result.value })
    } catch (error) {
      options.signal.throwIfAborted()
      results.push({ name: scenario.name, passed: false, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    sourceHash: createHash('sha256').update(options.code).digest('hex'),
    policy: structuredClone(options.policy),
    passed: results.every(result => result.passed),
    cases: results,
  }
}
