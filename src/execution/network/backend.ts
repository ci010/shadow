import { ProxyDetectionError, proxyFailureCode, type ProxyFailureCode } from './proxy-error.ts'
import { setGlobalDispatcher } from 'undici'
import { isLocalProxyEnabled, localProxyConfiguration, setLocalProxyEnabled, type ProxyConfiguration } from './proxy.ts'
import { LocalProxyDispatcher } from './proxy-client.ts'

const networkListeners = new Set<() => void>()

/** Notifies transports after a new proxy policy has been installed. */
export function onBackendNetworkChanged(listener: () => void): () => void {
  networkListeners.add(listener)
  return () => { networkListeners.delete(listener) }
}

function networkChanged(): void {
  for (const listener of networkListeners) {
    try { listener() } catch { console.error('[network] Transport refresh failed') }
  }
}

let revision = 0
let initialization: Promise<void> | undefined
let configuration: ProxyConfiguration = { source: 'unavailable', bypass: [] }
let failureCode: ProxyFailureCode | undefined

async function detectPolicy(detect: typeof localProxyConfiguration): Promise<{ policy: ProxyConfiguration; failure?: ProxyFailureCode }> {
  try { return { policy: await detect(undefined, { detectOnly: true }) } }
  catch (error) {
    // Never preserve raw causes: they can contain settings, credentials or command output.
    return { policy: { source: 'unavailable', bypass: [] }, failure: proxyFailureCode(error) }
  }
}

/** New requests use the current policy; in-flight requests are not interrupted. */
export function initializeBackendNetwork(enabled = true, detect = localProxyConfiguration): Promise<void> {
  return initialization ??= (async () => {
    // Install fail-closed routing before awaiting platform discovery.
    setGlobalDispatcher(new LocalProxyDispatcher(() => configuration))
    await updateBackendNetwork(enabled, detect, true)
    console.info(`[network] Backend proxy source: ${configuration.source}; loopback stays direct.`)
  })().catch(error => { initialization = undefined; throw error })
}

export async function updateBackendNetwork(enabled: boolean, detect = localProxyConfiguration, tolerateFailure = false): Promise<void> {
  const current = ++revision
  const result = enabled ? await detectPolicy(detect) : { policy: { source: 'direct' as const, bypass: [] } }
  const next = result.policy
  if (current !== revision) return
  if (result.failure && !tolerateFailure) throw new ProxyDetectionError(result.failure)
  const changed = enabled !== isLocalProxyEnabled() || JSON.stringify(configuration) !== JSON.stringify(next)
  configuration = next
  failureCode = result.failure
  if (failureCode) console.warn(`[network] ${failureCode}; external requests blocked; loopback stays direct.`)
  setLocalProxyEnabled(enabled)
  if (changed) networkChanged()
}

/** Re-detection never changes a saved enable/disable policy, including during a concurrent save. */
export async function refreshBackendNetwork(detect = localProxyConfiguration): Promise<void> {
  const current = revision
  if (!isLocalProxyEnabled()) return
  const result = await detectPolicy(detect)
  const next = result.policy
  if (current === revision && isLocalProxyEnabled()) {
    const changed = JSON.stringify(configuration) !== JSON.stringify(next)
    configuration = next
    failureCode = result.failure
    if (changed) networkChanged()
  }
}

/** Sanitized live default for session-scoped network policy reporting. */
export function backendNetworkPolicySummary() {
  return { source: configuration.source, enabled: isLocalProxyEnabled(), ...(failureCode ? { failureCode } : {}), blocked: configuration.source === 'unavailable' || configuration.source === 'macos-auto' }
}
