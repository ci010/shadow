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
let configuration: ProxyConfiguration = { source: 'direct', bypass: [] }

/** New requests use the current policy; in-flight requests are not interrupted. */
export function initializeBackendNetwork(enabled = true): Promise<void> {
  return initialization ??= (async () => {
    await updateBackendNetwork(enabled)
    setGlobalDispatcher(new LocalProxyDispatcher(() => configuration))
    console.info(`[network] Backend proxy source: ${configuration.source}; loopback stays direct.`)
  })().catch(error => { initialization = undefined; throw error })
}

export async function updateBackendNetwork(enabled: boolean): Promise<void> {
  const current = ++revision
  const next: ProxyConfiguration = enabled
    ? await localProxyConfiguration(undefined, { detectOnly: true })
    : { source: 'direct', bypass: [] }
  if (current !== revision) return
  const changed = enabled !== isLocalProxyEnabled() || JSON.stringify(configuration) !== JSON.stringify(next)
  configuration = next
  setLocalProxyEnabled(enabled)
  if (changed) networkChanged()
}

/** Re-detection never changes a saved enable/disable policy, including during a concurrent save. */
export async function refreshBackendNetwork(): Promise<void> {
  const current = revision
  if (!isLocalProxyEnabled()) return
  const next = await localProxyConfiguration(undefined, { detectOnly: true })
  if (current === revision && isLocalProxyEnabled()) {
    const changed = JSON.stringify(configuration) !== JSON.stringify(next)
    configuration = next
    if (changed) networkChanged()
  }
}

/** Sanitized live default for session-scoped network policy reporting. */
export function backendNetworkPolicySummary() {
  return { source: configuration.source, enabled: isLocalProxyEnabled() }
}
