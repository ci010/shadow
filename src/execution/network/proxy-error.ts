/** Fixed diagnostic categories only; never retain raw platform/configuration errors. */
export type ProxyFailureCode = 'SYSTEM_PROXY_READ_FAILED' | 'SYSTEM_PROXY_INVALID' | 'SYSTEM_PROXY_UNSUPPORTED' | 'SYSTEM_PROXY_UNAVAILABLE'
export class ProxyDetectionError extends Error {
  readonly code: ProxyFailureCode
  constructor(code: ProxyFailureCode) {
    super(`Local proxy policy unavailable (${code}); external requests are blocked. Retry proxy detection in Settings or explicitly disable the proxy policy.`)
    this.code = code
  }
}
export function proxyFailureCode(error: unknown): ProxyFailureCode {
  return error instanceof ProxyDetectionError ? error.code : 'SYSTEM_PROXY_UNAVAILABLE'
}
