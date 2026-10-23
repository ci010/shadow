import type { McpServerConfig } from '../config/schema.ts'

export type McpPhase = 'read_config' | 'validate_config' | 'connect' | 'list_tools' | 'call_tool' | 'disconnect'

export interface McpErrorContext {
  phase: McpPhase
  config?: McpServerConfig
  source?: string
  stderr?: string
  secrets?: readonly string[]
  transportError?: unknown
  elapsedMs?: number
}

export interface McpDiagnostic {
  phase: McpPhase
  server?: string
  transport?: McpServerConfig['transport']
  source?: string
  message: string
  category: string
  httpStatus?: number
  rpcCode?: number
  systemCode?: string
  retryable: boolean
  needsUserAction: boolean
  nextAction: string
  toolExecution: 'not_started' | 'unknown'
  causes?: string[]
  stderr?: string
  elapsedMs?: number
  packageErrorCode?: 'ETARGET' | 'E404' | 'EBADENGINE'
  cleanupFailure?: McpDiagnostic
}

const credentialKey = /authorization|cookie|token|secret|password|credential|api[-_]?key|device[-_]?code/i

/** Values are kept only in memory, never attached to errors or diagnostic objects. */
export function mcpSecrets(config?: McpServerConfig, environment?: Record<string, string>): string[] {
  const secrets = Object.values(config?.headers ?? {})
  for (const value of Object.values(config?.headers ?? {})) {
    if (typeof value !== 'string') continue
    const authorization = value.match(/^(Bearer|Basic)\s+(.+)$/i)
    if (authorization) {
      secrets.push(authorization[2])
      if (authorization[1].toLowerCase() === 'basic') {
        const decoded = Buffer.from(authorization[2], 'base64').toString('utf8')
        secrets.push(decoded, decoded.slice(decoded.indexOf(':') + 1))
      }
    }
  }
  for (const [key, value] of Object.entries(environment ?? config?.env ?? {})) {
    if (credentialKey.test(key)) secrets.push(value)
  }
  const args = config?.args ?? []
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith('-') || !credentialKey.test(args[i].split('=')[0])) continue
    const equal = args[i].indexOf('=')
    const value = equal < 0 ? args[i + 1] : args[i].slice(equal + 1)
    if (value) secrets.push(value)
  }
  if (config?.url && URL.canParse(config.url)) {
    const url = new URL(config.url)
    secrets.push(url.username, url.password, ...url.searchParams.values())
  }
  return [...new Set(secrets.filter((value): value is string => typeof value === 'string' && value.length > 0))]
}

export function redactMcpText(text: string, context: McpErrorContext): string {
  const values = [...mcpSecrets(context.config), ...(context.secrets ?? [])]
    .flatMap(value => [value, encodeURIComponent(value)])
    .filter(Boolean).sort((a, b) => b.length - a.length)
  let result = text
  for (const value of values) result = result.split(value).join('[redacted]')
  result = result.replace(/https?:\/\/[^\s"'<>]+/gi, value => {
    try {
      const url = new URL(value)
      url.username = ''
      url.password = ''
      url.search = ''
      url.hash = ''
      return url.toString()
    } catch {
      return '[redacted URL]'
    }
  })
  return result
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, '$1 [redacted]')
    .replace(/(["']?(?:authorization|cookie|set-cookie|[\w-]*(?:token|secret|password|credential|api[-_]?key|device[-_]?code))["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, '$1[redacted]')
    .slice(0, 4000)
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function errorMessage(error: unknown, phase: McpPhase): string {
  if (phase === 'validate_config' && error instanceof SyntaxError) {
    // JSON.parse errors can include a verbatim excerpt of credential-bearing JSON.
    const location = error.message.match(/(?:position \d+|line \d+ column \d+)[^)]*/)?.[0]
    return `Invalid JSON${location ? ` at ${location}` : ''}`
  }
  const issues = record(error).issues
  if (Array.isArray(issues)) {
    return issues.slice(0, 12).map(issue => {
      const { path, code, message } = record(issue)
      const reason = code === 'custom' && typeof message === 'string' ? message : typeof code === 'string' ? code : 'invalid value'
      return `${Array.isArray(path) ? path.join('.') : 'response'}: ${reason}`
    }).join('; ')
  }
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'MCP operation failed without an error message'
}

export class McpError extends Error {
  constructor(readonly diagnostic: McpDiagnostic) {
    super(JSON.stringify({ mcp_error: diagnostic }))
    this.name = 'McpError'
  }
}

export function mcpFailure(error: unknown, context: McpErrorContext): McpError {
  if (error instanceof McpError) {
    return context.source && !error.diagnostic.source
      ? new McpError({ ...error.diagnostic, source: redactMcpText(context.source, context) })
      : error
  }
  const chain: unknown[] = []
  for (let current: unknown = error; current && chain.length < 4 && !chain.includes(current); current = record(current).cause) chain.push(current)
  if (error instanceof AggregateError) {
    for (const cause of error.errors.slice(0, 4)) {
      if (!chain.includes(cause)) chain.push(cause)
    }
  }
  if (context.transportError && !chain.includes(context.transportError)) chain.push(context.transportError)
  const messages = chain.map(cause => redactMcpText(errorMessage(cause, context.phase), context))
  let httpStatus: number | undefined
  let rpcCode: number | undefined
  let systemCode: string | undefined
  for (const cause of chain) {
    const fields = record(cause)
    const status = fields.status ?? fields.statusCode ?? fields.code
    if (httpStatus === undefined && typeof status === 'number' && status >= 100 && status <= 599) httpStatus = status
    if (rpcCode === undefined && typeof fields.code === 'number' && fields.code < 0) rpcCode = fields.code
    if (systemCode === undefined && typeof fields.code === 'string' && /^[A-Z][A-Z0-9_]{1,60}$/.test(fields.code)) systemCode = fields.code
  }
  const message = messages[0] ?? 'MCP operation failed without an error message'
  const stderr = context.stderr ? redactMcpText(context.stderr, context) : undefined
  const detail = [...messages, stderr ?? ''].join('\n')
  const npmCode = context.phase === 'connect' && context.config?.transport === 'stdio'
    ? context.stderr?.match(/^npm (?:error|ERR!) code (ETARGET|E404|EBADENGINE)\s*$/m)?.[1]
    : undefined
  const packageErrorCode = npmCode === 'ETARGET' || npmCode === 'E404' || npmCode === 'EBADENGINE' ? npmCode : undefined
  let category = 'unknown'
  let retryable = false
  let needsUserAction = false
  let nextAction = 'Inspect the phase and sanitized cause. If unresolved, ask the user for help; do not retry blindly.'
  if (/configuration changed during import|tool list changed during import/i.test(detail)) {
    category = 'catalog_changed'
    retryable = true
    nextAction = 'Read the current catalog and import the source again before invoking any tool.'
  } else if (context.phase === 'validate_config') {
    category = 'invalid_config'
    nextAction = 'Correct the indicated configuration field or JSON syntax, then import again. Do not guess credentials.'
  } else if (httpStatus === 401 || /unauthorized|authentication required|login required|sign[- ]in required|interaction_required|invalid_grant/i.test(detail)) {
    category = 'authentication_required'
    needsUserAction = true
    nextAction = 'Ask the user to sign in or renew this server credential using its supported flow, then import again. Never request a token in chat.'
  } else if (httpStatus === 403 || systemCode === 'EACCES' || systemCode === 'EPERM') {
    category = 'permission_denied'
    needsUserAction = true
    nextAction = 'Ask the user to verify access to the server or local executable/configuration. Do not bypass access controls.'
  } else if (systemCode === 'ENOENT' || (context.phase === 'connect' && context.config?.transport === 'stdio' &&
    /not recognized as an internal or external command|command not found/i.test(detail))) {
    category = context.phase === 'read_config' ? 'config_not_found' : 'executable_not_found'
    nextAction = 'Verify the configured file/executable path and available runtime. Ask before installing software or changing persistent configuration.'
  } else if (/CERT|TLS|SSL/.test(systemCode ?? '')) {
    category = 'tls_error'
    needsUserAction = true
    nextAction = 'Ask the user to verify certificate trust, server URL and network setup. Do not disable TLS verification.'
  } else if (packageErrorCode) {
    category = packageErrorCode === 'EBADENGINE' ? 'runtime_incompatible' : 'package_unavailable'
    needsUserAction = true
    nextAction = packageErrorCode === 'EBADENGINE'
      ? 'The package launcher rejected the runtime version before MCP initialized. Check the required Node/npm version and selected executable. Do not disable engine checks or repeatedly reconnect.'
      : 'The configured package feed could not resolve the requested package/version before MCP initialized. Check the package specification and approved registry configuration; do not repeatedly reconnect, switch registries or substitute versions silently.'
  } else if (httpStatus === 429) {
    category = 'rate_limited'
    retryable = true
    nextAction = 'Wait before a bounded import retry; do not repeatedly reconnect to a rate-limited server.'
  } else if (rpcCode === -32001 || /^(ETIMEDOUT|ESOCKETTIMEDOUT|UND_ERR_CONNECT_TIMEOUT)$/.test(systemCode ?? '') || /timed out|timeout/i.test(detail)) {
    category = 'timeout'
    retryable = true
    nextAction = 'Check server/network availability, then retry the import at most once. Escalate repeated failures with this diagnostic.'
    if (context.phase === 'connect' && context.config?.transport === 'stdio') {
      nextAction = 'MCP initialization did not finish; no tool ran. Check sanitized stderr for package download, interactive install, executable startup or server initialization issues. A launched browser is not proof its adapter initialized. Retry import at most once; preserve this diagnostic if it repeats.'
    } else if (context.phase === 'call_tool') {
      nextAction = 'The tool request exceeded its deadline, not necessarily MCP initialization. Compare the requested work or in-page waits with the request timeout. Do not re-import or replay it blindly; use short observation calls to inspect pending effects. For long idle checks, record a timestamp and inspect later rather than sleeping inside one RPC.'
    }
  } else if (!(context.transportError instanceof SyntaxError) &&
    (rpcCode === -32000 || /^(ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE)$/.test(systemCode ?? ''))) {
    category = 'connection_error'
    retryable = true
    nextAction = 'Check the server process, address and network, then retry the import at most once. Escalate if it fails again.'
  } else if (rpcCode === -32602) {
    category = 'invalid_arguments'
    nextAction = 'Re-read the live tool contract and correct the arguments; do not repeat the same invalid request.'
  } else if (rpcCode === -32601 || rpcCode === -32600 || rpcCode === -32700 || context.transportError instanceof SyntaxError) {
    category = 'protocol_error'
    nextAction = 'Verify that this is an MCP endpoint and that the server supports the requested method/protocol. Re-import changed tool contracts.'
  } else if (httpStatus !== undefined && httpStatus >= 500) {
    category = 'server_error'
    retryable = true
    nextAction = 'Retry the import at most once after checking server availability; report repeated failure to the server owner.'
  }
  if (context.phase === 'call_tool') {
    retryable = false
    nextAction += ' The tool may have started: inspect its outcome before any retry, especially for writes.'
  }
  const diagnostic: McpDiagnostic = {
    phase: context.phase,
    ...(context.config ? { server: context.config.name, transport: context.config.transport } : {}),
    ...(context.source ? { source: redactMcpText(context.source, context) } : {}),
    message, category, httpStatus, rpcCode, systemCode, retryable, needsUserAction, nextAction,
    toolExecution: context.phase === 'call_tool' ? 'unknown' : 'not_started',
    ...(messages.length > 1 ? { causes: messages.slice(1) } : {}),
    ...(stderr ? { stderr } : {}),
    ...(context.elapsedMs !== undefined ? { elapsedMs: context.elapsedMs } : {}),
    ...(packageErrorCode ? { packageErrorCode } : {}),
  }
  return new McpError(diagnostic)
}

export function mcpCleanupFailure(primary: unknown, cleanup: unknown, context: McpErrorContext): McpError {
  const failure = mcpFailure(primary, context)
  return new McpError({
    ...failure.diagnostic,
    retryable: false,
    needsUserAction: true,
    nextAction: `Resolve the cleanup failure before reconnecting. ${failure.diagnostic.nextAction}`,
    cleanupFailure: mcpFailure(cleanup, { ...context, phase: 'disconnect' }).diagnostic,
  })
}
