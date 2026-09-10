import type { ExecutionContext } from '../agent/agent.ts'
import type { Hono } from 'hono'
import type { Context as HonoContext } from 'hono'
import { env } from 'node:process'
import type { Tools } from '../tools/registry.ts'

interface CallToolRequest {
  name: string
  args: Record<string, unknown>
}

interface CallToolResponse {
  ok: boolean
  result?: string
  error?: string
}

// ── Shared session handler registry ────────────────────────────────────

interface BridgeHandler {
  tools: Tools
  context: ExecutionContext
}

const bridgeHandlers = new Map<string, BridgeHandler>()

/**
 * Register the `/eval/*` catch-all route on the Hono app.
 * Must be called **before** `serveGateway()` so the route is part of the
 * compiled router. Individual sessions are dispatched via `bridgeHandlers`.
 */
export function registerEvalBridgeRoute(app: Hono): void {
  app.post('/eval/:sessionKey/call', async (c: HonoContext) => {
    const handler = bridgeHandlers.get(c.req.param('sessionKey') ?? '')
    if (!handler) return c.json({ ok: false, error: 'No active bridge for this session' } satisfies CallToolResponse, 404)

    let body: CallToolRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' } satisfies CallToolResponse, 400)
    }

    if (!body.name || typeof body.name !== 'string') {
      return c.json({ ok: false, error: 'Missing or invalid "name" field' } satisfies CallToolResponse, 400)
    }

    try {
      const result = await handler.tools.execute(body.name, body.args ?? {}, handler.context)
      return c.json({ ok: true, result } satisfies CallToolResponse)
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies CallToolResponse)
    }
  })

  app.get('/eval/:sessionKey/tools', (c: HonoContext) => {
    const handler = bridgeHandlers.get(c.req.param('sessionKey') ?? '')
    if (!handler) return c.json([], 404)
    return c.json(handler.tools.names())
  })
}

// ── Per-session bridge lifecycle ───────────────────────────────────────

/**
 * Start a tool bridge for eval child processes.
 *
 * Registers a handler in the shared dispatch map (the `/eval/*` route
 * is pre-registered on the Hono app via `registerEvalBridgeRoute`).
 *
 * Returns the base URL for the child process to use when calling tools.
 * The caller should pass this to the child via `SHADOW_TOOLS_URL` env var.
 */
export function startToolBridge(
  tools: Tools,
  context: ExecutionContext,
): { url: string; cleanup: () => void } {
  const sessionKey = context.sessionId.replace(/[^a-z0-9_-]/gi, '_')
  // Unique per-bridge key so concurrent bridges for the same session (e.g. a
  // long-lived background daemon plus a foreground exec) never clobber each
  // other's handler registration or cleanup.
  const bridgeKey = `${sessionKey}-${crypto.randomUUID().slice(0, 8)}`
  bridgeHandlers.set(bridgeKey, { tools, context })

  const port = env.GATEWAY_PORT ??
    env.REST_API_PORT ?? '3123'
  const host = env.GATEWAY_HOST ??
    env.REST_API_HOST ?? 'localhost'
  const baseUrl = `http://${host}:${port}/eval/${bridgeKey}`

  return {
    url: baseUrl,
    cleanup: () => { bridgeHandlers.delete(bridgeKey) },
  }
}

// ── Preamble generation ─────────────────────────────────────────────────

/**
 * JS reserved words and strict-mode restricted identifiers that cannot
 * be used as `const` binding names. Tool names matching these are skipped
 * in the generated preamble (they remain callable via `__call('name', args)`).
 */
const RESERVED_IDENTS = new Set([
  // ES reserved words
  'break',
  'case',
  'catch',
  'continue',
  'debugger',
  'default',
  'delete',
  'do',
  'else',
  'finally',
  'for',
  'function',
  'if',
  'in',
  'instanceof',
  'new',
  'return',
  'switch',
  'this',
  'throw',
  'try',
  'typeof',
  'var',
  'void',
  'while',
  'with',
  // Strict-mode restricted
  'eval',
  'arguments',
  // Future reserved (strict mode)
  'implements',
  'interface',
  'let',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'yield',
  // Other
  'class',
  'const',
  'enum',
  'export',
  'extends',
  'import',
  'super',
  // Preamble internals / helpers that would collide
  '__call',
  '__port',
  'pipe',
  'json',
  'lines',
  'map',
  'pick',
  'flat',
  'filter',
  'join',
  'count',
])

/** Core callTool function source (internal, not meant to be called directly) */
const CALL_TOOL_CORE = `\
const __url = process.env.SHADOW_TOOLS_URL;
async function __call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  if (!__url) throw new Error('Tool bridge not available');
  const r = await fetch(\`\${__url}/call\`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(process.env.SHADOW_TOOLS_CREDENTIAL
        ? { Authorization: \`Bearer \${process.env.SHADOW_TOOLS_CREDENTIAL}\` }
        : {}),
    },
    body: JSON.stringify({ name, args }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error(d.error ?? 'Tool call failed');
  try { return JSON.parse(d.result); } catch { return d.result; }
}
`

/** Pipe / transform helpers injected alongside tool functions. */
const HELPERS = `\
/** Chain async transforms: pipe(val, fn1, fn2, ...) */
async function pipe(v: any, ...fns: Array<(v: any) => any>): Promise<any> {
  let r = await v; for (const f of fns) r = await f(r); return r;
}
/** Parse JSON string, pass-through if already object */
function json(v: any) { return typeof v === 'string' ? JSON.parse(v) : v; }
/** Split string into non-empty lines */
function lines(v: string): string[] { return v.split('\\n').filter(Boolean); }
/** Async map */
function map<T, U>(arr: T[], fn: (v: T, i: number) => U | Promise<U>): Promise<U[]> { return Promise.all(arr.map(fn)); }
/** Pick a key from object */
function pick(v: any, k: string) { return v[k]; }
/** Flatten nested arrays one level */
function flat(v: any[]) { return v.flat(); }
/** Filter array */
function filter<T>(arr: T[], fn: (v: T) => boolean): T[] { return arr.filter(fn); }
/** Join array into string */
function join(arr: any[], sep = '\\n'): string { return arr.join(sep); }
/** Count items */
function count(v: any[] | string): number { return v.length; }
`

/**
 * Generate the eval preamble for inline scripts.
 * Creates a named function for every tool in the session so the agent
 * can write `read({ path: '...' })` instead of `callTool('read', ...)`.
 */
export function generatePreamble(toolNames: string[]): string {
  const toolFns = toolNames
    .filter((n) => !RESERVED_IDENTS.has(n))
    .map((n) =>
      `const ${n} = (a: Record<string, unknown> = {}) => __call('${n}', a);`
    )
    .join('\n')
  return `${CALL_TOOL_CORE}\n${toolFns}\n${HELPERS}\n`
}
