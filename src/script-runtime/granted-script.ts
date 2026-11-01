import { executeScript, ScriptCallError, type ScriptOptions } from './runtime.ts'
import { assertImportPolicy } from './module-policy.ts'
import { CapabilityError } from '../execution/grants.ts'

export type GrantedExecutionOptions = {
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

export function grantedModuleCall(callModule: GrantedExecutionOptions['callModule']): GrantedExecutionOptions['callModule'] {
  return async (name, input, signal) => {
    try { return await callModule(name, input, signal) }
    catch (error) {
      if (error instanceof CapabilityError) throw new ScriptCallError(error.code, error.message, error.status)
      throw error
    }
  }
}

export function grantedScriptOptions(options: GrantedExecutionOptions): ScriptOptions {
  const imports = options.imports ?? []
  assertImportPolicy(imports, options.allowedModules ?? [])
  return {
    code: options.code, args: options.args, signal: options.signal,
    filename: options.filename, cwd: options.cwd, entry: 'run',
    policy: { kind: 'restricted', imports, mode: options.mode },
    callModule: grantedModuleCall(options.callModule),
  }
}

export async function executeGrantedScript(options: GrantedExecutionOptions): Promise<unknown> {
  const result = await executeScript(grantedScriptOptions(options))
  return result.value
}
