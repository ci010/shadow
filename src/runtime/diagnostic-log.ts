import { redactDiagnosticUrls } from './module-diagnostic.ts'
import { getProjectScope } from '../projects/scope.ts'

export const READINESS_RESULTS = ['ready', 'invalid_credentials', 'permission_denied', 'network_error', 'cancelled_error'] as const
export type ReadinessResult = typeof READINESS_RESULTS[number]
const PROVIDERS = new Set(['agnes', 'anthropic', 'openai', 'deepseek', 'copilot', 'gemini', 'ollama', 'flash'])
export const RUNTIME_LOG_LIMIT = 200

/** Conservative export policy: credential/header/body-bearing messages are omitted,
 * not partially parsed. Console strings are not a reliable structured security boundary.
 * Never export arbitrary OTLP attributes, resources or structured bodies. */
export function redactRuntimeText(value: string): string {
  value = redactDiagnosticUrls(value)
  // Covers camel/snake/kebab keys, JSON and util.inspect output, HTTP headers,
  // command arguments and multiline payloads. Omit the entire message if uncertain.
  if (/\b[\w.-]*(?:token|secret|password|passwd|credential|api[-_]?key)[\w.-]*\s*["']?\s*[:=]/i.test(value) || /(?:--data(?:-raw|-binary)?\b|--header\b|(?:^|\s)-H\s)/.test(value) || /(?:authorization|proxy[-_ ]?authorization|api[-_ ]?key|access[-_ ]?token|refresh[-_ ]?token|id[-_ ]?token|client[-_ ]?secret|password|passwd|credential|private[-_ ]?key|cookie|set[-_ ]?cookie|secret|bearer\s|basic\s|(?:request|response)[-_ ]?body|\b(?:headers|body|payload|token|prompt|messages|request|response|input|output|content|signature|key|auth)\s*["']?\s*[:=])/i.test(value)) {
    return '[REDACTED: credential, header or payload-bearing message]'
  }
  return value
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]+/g, '[REDACTED TOKEN]')
    .slice(0, 4096)
}

function parse(value: unknown): any {
  if (typeof value !== 'string') return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

/** Safe bounded projection of the same project OTel rows used by the diagnosis UI. */
export function projectRuntimeRows(rows: unknown[], projectId: string): Array<Record<string, unknown>> {
  const output: Array<Record<string, unknown>> = []
  for (const value of rows.slice(0, RUNTIME_LOG_LIMIT)) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    const resource = parse(row.resource)
    const claimedProject = Array.isArray(resource?.attributes)
      ? resource.attributes.find((a: any) => a?.key === 'project.id')?.value?.stringValue
      : undefined
    if (claimedProject !== undefined && claimedProject !== projectId) continue
    if (!Number.isSafeInteger(row.id) || typeof row.time !== 'number' || !Number.isFinite(row.time) || Math.abs(row.time) > 8.64e15) continue
    const body = parse(row.body)
    const message = typeof body?.stringValue === 'string'
      ? redactRuntimeText(body.stringValue)
      : '[REDACTED: structured log body]'
    const severity = typeof row.severity === 'number' ? row.severity : 0
    const level = severity >= 21 ? 'fatal' : severity >= 17 ? 'error' : severity >= 13 ? 'warn' : severity >= 9 ? 'info' : severity >= 5 ? 'debug' : 'trace'
    const instrumentation = parse(row.scope)
    const source = typeof instrumentation?.name === 'string' ? redactRuntimeText(instrumentation.name).slice(0, 128) : 'otel'
    output.push({
      sequence: row.id, time: new Date(row.time).toISOString(), event: 'runtime_log',
      scope: 'project', level, source, message,
      ...(typeof row.trace_id === 'string' && /^[a-f0-9]{32}$/i.test(row.trace_id) ? { traceId: row.trace_id } : {}),
      ...(typeof row.span_id === 'string' && /^[a-f0-9]{16}$/i.test(row.span_id) ? { spanId: row.span_id } : {}),
    })
  }
  return output
}

/** Instance-owned allowlisted provider events; general logs reuse the project OTel store. */
export class RuntimeDiagnosticLog {
  private sequence = 0
  private readonly rows: Array<{ projectId?: string; event: Record<string, unknown> }> = []

  providerReadiness(provider: string, httpStatus: number | undefined, result: ReadinessResult): void {
    if (!READINESS_RESULTS.includes(result)) return
    const scope = getProjectScope()
    if (scope?.closed) return
    const event = {
      sequence: ++this.sequence,
      time: new Date().toISOString(),
      event: 'provider_readiness',
      scope: scope ? 'project' : 'shared_provider_setup',
      level: result === 'ready' ? 'info' : 'warn', source: 'provider_setup',
      message: `Provider readiness: ${result}`,
      provider: PROVIDERS.has(provider) ? provider : 'custom',
      method: 'GET', endpoint: '/models',
      ...(Number.isInteger(httpStatus) && httpStatus! >= 100 && httpStatus! <= 599 ? { httpStatus } : {}),
      result,
    }
    this.rows.push({ projectId: scope?.projectId, event })
    if (this.rows.length > RUNTIME_LOG_LIMIT) this.rows.shift()
  }

  read(projectId: string, generalRows: unknown[] = []): string {
    const events = [
      ...this.rows.filter(row => !row.projectId || row.projectId === projectId).map(row => row.event),
      ...projectRuntimeRows(generalRows, projectId),
    ].sort((a, b) => String(a.time).localeCompare(String(b.time)) || Number(a.sequence) - Number(b.sequence)).slice(-RUNTIME_LOG_LIMIT)
    return events.map(event => JSON.stringify(event)).join('\n')
      || 'No retained runtime diagnostic events for this Project/current instance.'
  }
}
