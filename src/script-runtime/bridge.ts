import type { ExecutionContext } from '../tools/context.ts'
import type { Hono } from 'hono'
import type { Context as HonoContext } from 'hono'
import { env } from 'node:process'
import type { Tools } from '../tools/registry.ts'
import { getOrganizationScope, type OrganizationScope } from '../organizations/scope.ts'

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
  controller?: AbortController
}

export interface EvalBridgeOptions {
  organizationId: string
  scope: OrganizationScope
  /** Full gateway route base, including the organization route prefix. */
  gatewayBaseUrl: string
}

export interface ToolBridgeFactory {
  startToolBridge(tools: Tools, context: ExecutionContext): { url: string; cleanup: () => void }
}

/** The registry and tool closures belong to one runtime, never to the host router. */
export class EvalBridgeRuntime implements ToolBridgeFactory {
  private handlers = new Map<string, BridgeHandler>()
  private closed = false
  private baseUrl = ''
  private calls = new Set<Promise<unknown>>()

  constructor(readonly options: EvalBridgeOptions) {
    if (!options.organizationId || options.scope.organizationId !== options.organizationId || options.scope.closed) {
      throw new Error('Eval bridge requires a matching live organization scope')
    }
    this.options = Object.freeze({ ...options })
    this.setGatewayBaseUrl(options.gatewayBaseUrl)
  }

  setGatewayBaseUrl(gatewayBaseUrl: string): void {
    if (this.closed || this.options.scope.closed) throw new Error('Eval bridge runtime is closed')
    if (this.handlers.size) throw new Error('Cannot change gateway base while eval bridges are active')
    const url = new URL(gatewayBaseUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new TypeError('Eval bridge requires an HTTP gateway base URL without credentials, query or fragment')
    }
    this.baseUrl = url.href.replace(/\/$/, '')
  }

  startToolBridge(tools: Tools, context: ExecutionContext): { url: string; cleanup: () => void } {
    this.assertContext(context)
    if (tools !== context.tools) throw new Error('Eval bridge tools must belong to the bound execution context')
    const key = crypto.randomUUID()
    const controller = new AbortController()
    this.handlers.set(key, {
      tools, controller,
      context: { ...context, signal: AbortSignal.any([context.signal, controller.signal]) },
    })
    return {
      url: `${this.baseUrl}/eval/${key}`,
      cleanup: () => {
        this.handlers.delete(key)
        controller.abort(new Error('Eval bridge closed'))
      },
    }
  }

  private assertContext(context: ExecutionContext): void {
    const ambient = getOrganizationScope()
    if (this.closed || this.options.scope.closed) throw new Error('Eval bridge runtime is closed')
    if (context.organizationId !== this.options.organizationId || context.evalBridge !== this ||
      (ambient !== undefined && ambient !== this.options.scope)) {
      throw new Error('Eval bridge organization/runtime binding mismatch')
    }
    if (!context.sessionId?.trim()) throw new Error('Eval bridge requires a session identity')
  }

  registerRoutes(app: Hono): void {
    registerBridgeRoutes(app, (key) => {
      if (this.closed || this.options.scope.closed) return undefined
      return this.handlers.get(key)
    }, (handler, callback) => {
      this.assertContext(handler.context)
      handler.context.signal.throwIfAborted()
      const result = this.options.scope.run(callback)
      const pending = Promise.resolve(result)
      this.calls.add(pending)
      void pending.then(() => this.calls.delete(pending), () => this.calls.delete(pending))
      return result
    })
  }

  async shutdown(): Promise<void> {
    this.closed = true
    for (const handler of this.handlers.values()) handler.controller?.abort(new Error('Eval runtime stopped'))
    this.handlers.clear()
    await Promise.allSettled(this.calls)
  }
}

// Compatibility for unowned pre-organization callers and existing standalone tests.
const legacyBridgeHandlers = new Map<string, BridgeHandler>()

/**
 * Register the `/eval/*` catch-all route on the Hono app.
 * Must be called **before** `serveGateway()` so the route is part of the
 * compiled router. Organization routes receive their own runtime registry.
 */
export function registerEvalBridgeRoute(app: Hono, runtime?: EvalBridgeRuntime): void {
  if (runtime) return runtime.registerRoutes(app)
  registerBridgeRoutes(app, (key) => legacyBridgeHandlers.get(key), (_handler, callback) => {
    if (getOrganizationScope()) throw new Error('Legacy eval bridge cannot run in an organization runtime')
    return callback()
  })
}

function registerBridgeRoutes(
  app: Hono,
  lookup: (key: string) => BridgeHandler | undefined,
  run: <T>(handler: BridgeHandler, callback: () => T) => T,
): void {
  app.post('/eval/:sessionKey/call', async (c: HonoContext) => {
    const handler = lookup(c.req.param('sessionKey') ?? '')
    if (!handler) return c.json({ ok: false, error: 'No active bridge for this session' } satisfies CallToolResponse, 404)

    let body: CallToolRequest
    try {
      body = await c.req.json()
    } catch {
      return c.json({ ok: false, error: 'Invalid JSON body' } satisfies CallToolResponse, 400)
    }

    if (!body || typeof body !== 'object' || !body.name || typeof body.name !== 'string') {
      return c.json({ ok: false, error: 'Missing or invalid "name" field' } satisfies CallToolResponse, 400)
    }
    if (body.args !== undefined && (!body.args || typeof body.args !== 'object' || Array.isArray(body.args))) {
      return c.json({ ok: false, error: 'Invalid "args" field' } satisfies CallToolResponse, 400)
    }

    try {
      const result = await run(handler, () => handler.tools.execute(body.name, body.args ?? {}, handler.context))
      return c.json({ ok: true, result } satisfies CallToolResponse)
    } catch (err) {
      return c.json({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      } satisfies CallToolResponse)
    }
  })

  app.get('/eval/:sessionKey/tools', (c: HonoContext) => {
    const handler = lookup(c.req.param('sessionKey') ?? '')
    if (!handler) return c.json([], 404)
    try {
      return c.json(run(handler, () => handler.tools.names()))
    } catch (error) {
      return c.json({ ok: false, error: error instanceof Error ? error.message : String(error) }, 403)
    }
  })
}

// ── Per-session bridge lifecycle ───────────────────────────────────────

/**
 * Start a tool bridge for eval child processes.
 *
 * Organization execution uses the injected runtime registry. The module-level
 * compatibility registry accepts only contexts without organization ownership.
 *
 * Returns the base URL for the child process to use when calling tools.
 * The caller should pass this to the child via `SHADOW_TOOLS_URL` env var.
 */
export function startToolBridge(
  tools: Tools,
  context: ExecutionContext,
): { url: string; cleanup: () => void } {
  if (context.evalBridge) return context.evalBridge.startToolBridge(tools, context)
  if (context.organizationId !== undefined || getOrganizationScope()) {
    throw new Error('Organization execution requires an injected eval bridge runtime')
  }
  const sessionKey = context.sessionId.replace(/[^a-z0-9_-]/gi, '_')
  // Unique per-bridge key so concurrent bridges for the same session (e.g. a
  // long-lived background daemon plus a foreground exec) never clobber each
  // other's handler registration or cleanup.
  const bridgeKey = `${sessionKey}-${crypto.randomUUID()}`
  legacyBridgeHandlers.set(bridgeKey, { tools, context: { ...context } })

  const port = env.GATEWAY_PORT ??
    env.REST_API_PORT ?? '3123'
  const host = env.GATEWAY_HOST ??
    env.REST_API_HOST ?? 'localhost'
  const baseUrl = `http://${host}:${port}/eval/${bridgeKey}`

  return {
    url: baseUrl,
    cleanup: () => { legacyBridgeHandlers.delete(bridgeKey) },
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
