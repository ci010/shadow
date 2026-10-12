import { setGlobalDispatcher } from 'undici'
import { isLocalProxyEnabled, localProxyConfiguration, setLocalProxyEnabled, type ProxyConfiguration } from './proxy.ts'
import { LocalProxyDispatcher } from './proxy-client.ts'

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
  configuration = next
  setLocalProxyEnabled(enabled)
}

/** Re-detection never changes a saved enable/disable policy, including during a concurrent save. */
export async function refreshBackendNetwork(): Promise<void> {
  const current = revision
  if (!isLocalProxyEnabled()) return
  const next = await localProxyConfiguration(undefined, { detectOnly: true })
  if (current === revision && isLocalProxyEnabled()) configuration = next
}
