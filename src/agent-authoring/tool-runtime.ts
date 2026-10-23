import { executeScript, ScriptCallError, type ScriptOptions } from '../script-runtime/runtime.ts'
import { assertImportPolicy } from '../script-runtime/module-policy.ts'
import { CapabilityError } from './capabilities.ts'

export type AuthoredExecutionOptions = {
  code: string
  args: Record<string, unknown>
  signal: AbortSignal
  filename?: string
  imports?: readonly string[]
  allowedModules?: readonly string[]
  mode?: 'live' | 'test' | 'probe'
  cwd?: string
  callModule: (name: string, input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

export function authoredModuleCall(callModule: AuthoredExecutionOptions['callModule']): AuthoredExecutionOptions['callModule'] {
  return async (name, input, signal) => {
    try { return await callModule(name, input, signal) }
    catch (error) {
      if (error instanceof CapabilityError) throw new ScriptCallError(error.code, error.message, error.status)
      throw error
    }
  }
}

export function authoredScriptOptions(options: AuthoredExecutionOptions): ScriptOptions {
  const imports = options.imports ?? []
  assertImportPolicy(imports, options.allowedModules ?? [])
  return {
    code: options.code, args: options.args, signal: options.signal,
    filename: options.filename, cwd: options.cwd, entry: 'run',
    policy: { kind: 'restricted', imports, mode: options.mode },
    callModule: authoredModuleCall(options.callModule),
  }
}

export async function executeAuthoredTool(options: AuthoredExecutionOptions): Promise<unknown> {
  const result = await executeScript(authoredScriptOptions(options))
  return result.value
}
