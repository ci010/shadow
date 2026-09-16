/**
 * Shared types and protocol constants between eval parent (shell.ts)
 * and the script-runtime child process (child.ts).
 *
 * This file has ZERO transitive dependencies so both sides can import
 * it without pulling in agent-loop, tool registry, or any bot module.
 */

export interface EvalRunnerRequest {
  module: string
  args: string[]
  cwd: string
}

export interface EvalRunnerResponse {
  ok: boolean
  module: string
  cwd: string
  stdout: string
  stderr: string
  result?: unknown
  error?: string
}

export const RUNNER_RESPONSE_PREFIX = '__EVAL_RUNNER_JSON__:'
