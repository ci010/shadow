import type { ExecutionContext } from '../tools/context.ts'
import { getProjectScope, type ProjectScope } from '../projects/scope.ts'

export interface EvalBridgeOptions {
  projectId: string
  scope: ProjectScope
}

export interface ToolBridgeFactory {
  bindTools(context: ExecutionContext, options?: ScriptToolBindingOptions): ScriptToolBinding
}

export interface ScriptToolBindingOptions {
  dynamic?: boolean
}

export interface ScriptToolBinding {
  signal: AbortSignal
  /** Available base-tool globals, not a ceiling on declared controlled imports. */
  names: string[]
  call(name: string, input: Record<string, unknown>, signal: AbortSignal): Promise<unknown>
  /** Abort and revoke immediately; project shutdown separately drains accepted calls. */
  cleanup(): Promise<void>
}

function createToolBinding(
  context: ExecutionContext,
  run: <T>(callback: () => T) => T,
  options: ScriptToolBindingOptions = {},
): ScriptToolBinding {
  if (!context.tools || !context.sessionId?.trim()) throw new Error('Script tools require a bound session')
  const controller = new AbortController()
  const signal = AbortSignal.any([context.signal, controller.signal])
  return {
    signal,
    names: context.tools.names(),
    call(name, input, callSignal) {
      const pending = (async () => {
        signal.throwIfAborted()
        const nested: ExecutionContext = {
          ...context,
          signal: AbortSignal.any([signal, callSignal]),
          toolCallId: crypto.randomUUID(),
          toolCallName: name,
        }
        const result = await run(() => {
          if (options.dynamic && context.tools.hasDynamic(name)) {
            return context.tools.executeDynamic(name, input, nested)
          }
          if (!options.dynamic || context.tools.has(name) || !context.tools.canUseDynamic(name)) {
            return context.tools.execute(name, input, nested)
          }
          return context.tools.execute('invoke_tool', { name, args: input }, nested)
        })
        if (typeof result !== 'string') return result
        try { return JSON.parse(result) }
        catch { return result }
      })()
      return pending
    },
    async cleanup() {
      controller.abort(new Error('Script tool binding closed'))
    },
  }
}

/** Bind worker RPC to session authorization and its owning project lifecycle. */
export function bindScriptTools(context: ExecutionContext, options: ScriptToolBindingOptions = {}): ScriptToolBinding {
  if (context.evalBridge) return context.evalBridge.bindTools(context, options)
  if (context.projectId !== undefined || getProjectScope()) {
    throw new Error('Project execution requires an injected eval bridge runtime')
  }
  return createToolBinding(context, callback => {
    if (getProjectScope()) throw new Error('Unowned script cannot run in a project runtime')
    return callback()
  }, options)
}

/** Tool closures and pending calls belong to one project runtime. */
export class EvalBridgeRuntime implements ToolBridgeFactory {
  private closed = false
  private calls = new Set<Promise<unknown>>()
  private bindings = new Set<ScriptToolBinding>()

  constructor(readonly options: EvalBridgeOptions) {
    if (!options.projectId || options.scope.projectId !== options.projectId || options.scope.closed) {
      throw new Error('Eval bridge requires a matching live project scope')
    }
    this.options = Object.freeze({ ...options })
  }

  bindTools(context: ExecutionContext, options: ScriptToolBindingOptions = {}): ScriptToolBinding {
    this.assertContext(context)
    const binding = createToolBinding(context, callback => {
      this.assertContext(context)
      const result = this.options.scope.run(callback)
      const pending = Promise.resolve(result)
      this.calls.add(pending)
      void pending.then(() => this.calls.delete(pending), () => this.calls.delete(pending))
      return result
    }, options)
    const cleanup = binding.cleanup
    binding.cleanup = async () => {
      try { await cleanup() }
      finally { this.bindings.delete(binding) }
    }
    this.bindings.add(binding)
    return binding
  }

  private assertContext(context: ExecutionContext): void {
    const ambient = getProjectScope()
    if (this.closed || this.options.scope.closed) throw new Error('Eval bridge runtime is closed')
    if (context.projectId !== this.options.projectId || context.evalBridge !== this ||
      (ambient !== undefined && ambient !== this.options.scope)) {
      throw new Error('Eval bridge project/runtime binding mismatch')
    }
    if (!context.sessionId?.trim()) throw new Error('Eval bridge requires a session identity')
  }

  async shutdown(): Promise<void> {
    this.closed = true
    await Promise.allSettled([...this.calls, ...Array.from(this.bindings, binding => binding.cleanup())])
  }
}
