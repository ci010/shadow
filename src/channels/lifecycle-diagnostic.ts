import { redactRuntimeText } from '../runtime/diagnostic-log.ts'

/** Never serialize SDK error objects: they can contain requests and credentials. */
export function lifecycleErrorDetail(error: unknown, config: unknown): string {
  const secrets: string[] = []
  const collect = (value: unknown, depth = 0): void => {
    if (!value || typeof value !== 'object' || depth > 8) return
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'string' && /token|secret|password|credential|api.?key/i.test(key) && item) secrets.push(item)
      else if (item && typeof item === 'object') collect(item, depth + 1)
    }
  }
  collect(config)
  const clean = (text: string): string => {
    for (const secret of secrets.sort((a, b) => b.length - a.length)) text = text.split(secret).join('[REDACTED]')
    return text.split('\n').map(line => redactRuntimeText(line)).join('\n')
  }
  const describe = (value: unknown, depth: number): string => {
    if (!(value instanceof Error)) return '[non-Error thrown; value omitted]'
    const code = (value as Error & { code?: unknown }).code
    const detail = clean((value.stack || `${value.name}: ${value.message}`).slice(0, 16384))
    const safeCode = typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? ` code=${clean(code)}` : ''
    return `${detail}${safeCode}${depth < 2 && value.cause !== undefined ? `\nCaused by: ${describe(value.cause, depth + 1)}` : ''}`
  }
  return describe(error, 0).slice(0, 6000)
}
