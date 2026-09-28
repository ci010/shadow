import type { ExecutionContext } from './context.ts'
import type { ContentPart } from '../providers/provider.ts'

export type ToolResult = string | { content: ContentPart[]; isError?: boolean }

/** Only trusted implementations may attest that a failed operation had no effect. */
export class ToolNoEffectError extends Error {}

export function toolResultText(result: ToolResult): string {
  return typeof result === 'string' ? result : result.content
    .filter(part => part.type === 'text').map(part => part.text).join('\n')
}

/** Text-only integrations must not silently discard visual tool output. */
export function requireToolText(result: ToolResult): string {
  if (typeof result !== 'string') throw new Error('This consumer accepts text only. Invoke the tool directly to deliver its image result to the model.')
  return result
}

/**
 * JSON-Schema-style parameter definition for a tool, compatible with
 * OpenAI function-calling format.
 */
export interface ToolParameters {
  type: 'object'
  properties: Record<string, {
    type: string
    description?: string
    enum?: string[]
    items?: {
      type: string
      properties?: Record<string, { type: string; description?: string }>
      required?: string[]
    }
    default?: unknown
  }>
  required?: string[]
  [key: string]: unknown
}

/**
 * A single tool that the agent can invoke.
 */
export interface Tool<Result extends ToolResult = string> {
  /** Unique tool name (snake_case). */
  readonly name: string
  /** Human-readable description for the LLM. */
  readonly description: string
  /** JSON Schema for the parameters object. */
  readonly parameters: ToolParameters
  /** True (or true for these arguments) means the call only reads state and can run in parallel. */
  readonly readonly?: boolean | ((args: Record<string, unknown>) => boolean)
  /** Explicitly opts the tool into capability-backed remote workspace handling. */
  readonly supportsRemoteWorkdir?: boolean
  /** If true, this tool is opt-in only — hidden unless explicitly listed in allowedTools. */
  readonly optIn?: boolean

  /**
   * System-provided execution context.
   * This is not model-provided tool args.
   */
  execute(
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<Result>

  getChatTextDisplay?(args: Record<string, unknown>): string
}

/**
 * OpenAI function-calling tool definition shape.
 */
export interface ToolDefinition {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: ToolParameters
  }
  optIn?: boolean
}

/**
 * Hook that runs after a tool executes.
 *
 * Hooks can inspect the tool name, args, and result, then return either:
 * - A **string** to append to the tool result (e.g. diagnostics).
 * - An object `{ replace: string }` to replace the entire result.
 * - `undefined` to leave the result unchanged.
 *
 * Hooks run in registration order. Each hook sees the result as modified
 * by previous hooks.
 */
export interface ToolExecutionHook {
  /** Short identifier for logging. */
  readonly name: string

  beforeExecute?(
    toolName: string,
    args: Record<string, unknown>,
    context: ExecutionContext,
  ): Promise<void>

  /**
   * Called after a tool has executed successfully.
   *
   * @param toolName  Name of the tool that just ran.
   * @param args      The model-provided arguments.
   * @param result    The tool's return string.
   * @param context   Execution context (session key, workspace, etc.).
   * @returns Text to append, `{ replace }` to replace, or undefined to skip.
   */
  afterExecute(
    toolName: string,
    args: Record<string, unknown>,
    result: string,
    context: ExecutionContext,
  ): Promise<string | { replace: string } | undefined>
}
