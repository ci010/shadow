/**
 * Standalone child process for the eval tool.
 *
 * Invoked by the parent (shell.ts) via:
 *   node src/script-runtime/child.ts --eval-runner <base64-payload>
 *
 * This file has NO imports from the bot codebase (agent-loop, registry, etc).
 * Only depends on Node.js and lightweight runtime helpers.
 */

import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import process from 'node:process'
import { env } from 'node:process'
import { RUNNER_RESPONSE_PREFIX } from './types.ts'
import type { EvalRunnerRequest, EvalRunnerResponse } from './types.ts'
import { registerTypeScriptLoader } from '../utils/typescript.ts'

// ── Shared helpers ────────────────────────────────────────────────────

/**
 * Discover available tools from the bridge server and inject them
 * (plus pipe helpers) onto globalThis so scripts can use
 * `read({ path })` without any imports.
 */
async function setupToolGlobals(): Promise<void> {
  const url = env.SHADOW_TOOLS_URL
  if (!url) return

  const g = globalThis as Record<string, unknown>
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (env.SHADOW_TOOLS_CREDENTIAL) {
    headers.Authorization = `Bearer ${env.SHADOW_TOOLS_CREDENTIAL}`
  }

  const SKIP = new Set([
    'eval',
    'arguments',
    'undefined',
    'NaN',
    'Infinity',
    'pipe',
    'json',
    'lines',
    'pick',
    'flat',
    'join',
    'count',
  ])

  const __call = async (name: string, args: Record<string, unknown> = {}) => {
    const r = await fetch(`${url}/call`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name, args }),
    })
    const d = await r.json()
    if (!d.ok) throw new Error(d.error ?? 'Tool call failed')
    try {
      return JSON.parse(d.result)
    } catch {
      return d.result
    }
  }

  const names: string[] = await fetch(`${url}/tools`, { headers }).then((r) => r.json())
  for (const n of names) {
    if (SKIP.has(n)) continue
    g[n] = (a: Record<string, unknown> = {}) => __call(n, a)
  }

  g.pipe = async (v: unknown, ...fns: Array<(v: unknown) => unknown>) => {
    let r = await v
    for (const f of fns) r = await f(r)
    return r
  }
  g.json = (v: unknown) => typeof v === 'string' ? JSON.parse(v) : v
  g.lines = (v: string) => v.split('\n').filter(Boolean)
  g.pick = (v: Record<string, unknown>, k: string) => v[k]
  g.flat = (v: unknown[]) => v.flat()
  g.join = (arr: unknown[], sep = '\n') => arr.join(sep)
  g.count = (v: unknown[] | string) => v.length
}

function formatConsoleLine(values: unknown[]): string {
  return values.map(formatConsoleValue).join(' ')
}

function formatConsoleValue(value: unknown): string {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function safeResult(value: unknown): unknown {
  if (value === undefined) return undefined
  try {
    JSON.stringify(value)
    return value
  } catch {
    return String(value)
  }
}

function makeConsoleProxy(
  stdoutLines: string[],
  stderrLines: string[],
): Console {
  const original = console
  return {
    ...original,
    log: (...values: unknown[]) => stdoutLines.push(formatConsoleLine(values)),
    info: (...values: unknown[]) => stdoutLines.push(formatConsoleLine(values)),
    debug: (...values: unknown[]) =>
      stdoutLines.push(formatConsoleLine(values)),
    warn: (...values: unknown[]) => stderrLines.push(formatConsoleLine(values)),
    error: (...values: unknown[]) =>
      stderrLines.push(formatConsoleLine(values)),
  }
}

// ── Runner helpers ───────────────────────────────────────────────────

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

function decodePayload(base64: string): EvalRunnerRequest | null {
  try {
    const bytes = fromBase64(base64)
    const json = new TextDecoder().decode(bytes)
    const parsed = JSON.parse(json) as Partial<EvalRunnerRequest>
    if (typeof parsed.module !== 'string' || typeof parsed.cwd !== 'string') {
      return null
    }
    const args = Array.isArray(parsed.args)
      ? parsed.args.filter((value): value is string =>
        typeof value === 'string'
      )
      : []
    return { module: parsed.module, cwd: parsed.cwd, args }
  } catch {
    return null
  }
}

function resolveModuleSpecifier(input: string, cwd: string): string {
  if (input.startsWith('file://')) {
    return input
  }
  const absolutePath = isAbsolute(input) ? input : resolve(cwd, input)
  return pathToFileURL(absolutePath).href
}

async function runImportedModule(
  moduleValue: Record<string, unknown>,
  args: string[],
): Promise<unknown> {
  const defaultExport = moduleValue.default
  if (typeof defaultExport === 'function') {
    return await Promise.resolve(defaultExport(args))
  }
  const runExport = moduleValue.run
  if (typeof runExport === 'function') {
    return await Promise.resolve(runExport(args))
  }
  const mainExport = moduleValue.main
  if (typeof mainExport === 'function') {
    return await Promise.resolve(mainExport(args))
  }
  return null
}

function writeJsonToStdout(value: EvalRunnerResponse): void {
  const safe = { ...value, result: safeResult(value.result) }
  const serialized = `${RUNNER_RESPONSE_PREFIX}${JSON.stringify(safe)}\n`
  process.stdout.write(serialized)
}

// ── Runner entry point ────────────────────────────────────────────────

async function runEvalRunner(
  payloadBase64: string | undefined,
): Promise<number> {
  if (!payloadBase64) {
    await writeJsonToStdout({
      ok: false,
      module: '',
      cwd: '',
      stdout: '',
      stderr: '',
      error: 'Missing eval runner payload',
    })
    return 2
  }

  const request = decodePayload(payloadBase64)
  if (!request) {
    await writeJsonToStdout({
      ok: false,
      module: '',
      cwd: '',
      stdout: '',
      stderr: '',
      error: 'Invalid eval runner payload',
    })
    return 2
  }

  const stdoutLines: string[] = []
  const stderrLines: string[] = []
  const originalConsole = console
  globalThis.console = makeConsoleProxy(stdoutLines, stderrLines)

  try {
    registerTypeScriptLoader()
    await setupToolGlobals()

    const moduleSpecifier = resolveModuleSpecifier(request.module, request.cwd)
    const imported = await import(moduleSpecifier)
    const result = await runImportedModule(imported, request.args)

    await writeJsonToStdout({
      ok: true,
      module: moduleSpecifier,
      cwd: request.cwd,
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
      result,
    })
    return 0
  } catch (err) {
    const errorMessage = err instanceof Error
      ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
      : String(err)
    await writeJsonToStdout({
      ok: false,
      module: request.module,
      cwd: request.cwd,
      stdout: stdoutLines.join('\n'),
      stderr: stderrLines.join('\n'),
      error: errorMessage,
    })
    return 1
  } finally {
    globalThis.console = originalConsole
  }
}

// ── Main dispatch ────────────────────────────────────────────────────

if (import.meta.main) {
  const mode = process.argv[2]

  if (mode === '--eval-runner') {
    process.exitCode = await runEvalRunner(process.argv[3])
  } else {
    console.error(`[eval-child] Unknown mode: ${mode ?? '(none)'}`)
    process.exitCode = 2
  }
}
