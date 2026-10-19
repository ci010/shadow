import { backendNetworkPolicySummary } from './backend.ts'
import { Agent } from 'undici'
import { LocalProxyDispatcher } from './proxy-client.ts'
import { localProxyConfiguration, proxyForUrl, type ProxyConfiguration } from './proxy.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { SessionTools } from '../../tools/registry.ts'

type Override = { mode: 'direct' } | { mode: 'proxy'; proxyId: 'configured'; configuration: ProxyConfiguration }
const policies = new WeakMap<SessionTools, Override>()
const owner = (context: ExecutionContext) => context.tools.dynamicOwner
export function sessionProxyOverride(context?: ExecutionContext): boolean {
  return !!context?.tools && policies.has(owner(context))
}

export async function configureSessionProxy(context: ExecutionContext, mode: 'direct' | 'proxy', proxyId?: string, detect = localProxyConfiguration): Promise<void> {
  if (context.remoteWorkdir) throw new Error('Session proxy overrides are not supported with a remote workdir; no remote network policy capability exists.')
  let policy: Override
  if (mode === 'direct') policy = { mode }
  else {
    if (proxyId !== 'configured') throw new Error('Unknown proxyId. The only supported ID is configured (existing environment/Windows static proxy).')
    const configuration = await detect(context.signal, { detectOnly: true })
    if (configuration.source === 'windows-auto') throw new Error('Explicit proxy selection does not support Windows PAC/automatic routes; configure a static HTTP(S) proxy.')
    if (!configuration.http && !configuration.https) throw new Error('No configured static proxy is available.')
    policy = { mode, proxyId: 'configured', configuration }
  }
  context.signal.throwIfAborted()
  const key = owner(context)
  if (!policies.has(key)) key.onReset(() => { policies.delete(key) })
  policies.set(key, policy)
}
export function resetSessionProxy(context: ExecutionContext): void { policies.delete(owner(context)) }
export function describeSessionProxy(context: ExecutionContext) {
  const policy = policies.get(owner(context))
  return {
    configuration: policy ? { mode: policy.mode, ...(policy.mode === 'proxy' ? { proxyId: policy.proxyId } : {}) } : { mode: 'inherit' },
    effective: policy ? { mode: policy.mode, ...(policy.mode === 'proxy' ? { source: policy.configuration.source, fallback: false } : {}) }
      : { mode: 'application-default', dynamic: true, ...backendNetworkPolicySummary() },
    scope: 'current session search web and read URL only; cleared on session sleep/reset; not persisted',
    supportedProxyIds: ['configured'],
    proxyIdMeaning: 'configured resolves the existing environment/Windows static proxy at set time; availability is validated on set',
  }
}

/** Only called by built-in web search and URL read. Never changes global dispatch/environment. */
export async function sessionWebFetch(url: string, init: RequestInit, context?: ExecutionContext): Promise<Response> {
  const policy = context?.tools && policies.get(owner(context))
  if (!policy) return fetch(url, init)
  if (context?.remoteWorkdir) throw new Error('Session proxy overrides cannot be applied to remote network requests.')
  // Capture an immutable policy for this entire fetch, including redirects and body consumption.
  const dispatcher = policy.mode === 'direct' ? new Agent() : new StrictProxyDispatcher(policy.configuration)
  try {
    const response = await fetch(url, { ...init, dispatcher } as RequestInit)
    const body = await response.arrayBuffer()
    return new Response(body.byteLength ? body : null, { status: response.status, statusText: response.statusText, headers: response.headers })
  } catch (error) {
    init.signal?.throwIfAborted()
    if (error instanceof SessionProxyRouteError || (error instanceof Error && error.cause instanceof SessionProxyRouteError)) {
      throw new Error('Session proxy has no route for this destination (bypass, loopback or missing protocol); no fallback was attempted.')
    }
    throw new Error(`Session ${policy.mode} request failed; no fallback was attempted.`)
  } finally { await dispatcher.destroy() }
}

class SessionProxyRouteError extends Error {}

class StrictProxyDispatcher extends LocalProxyDispatcher {
  constructor(private readonly policy: ProxyConfiguration) { super(policy) }
  override dispatch(options: Parameters<LocalProxyDispatcher['dispatch']>[0], handler: Parameters<LocalProxyDispatcher['dispatch']>[1]): boolean {
    // Respect configured bypass/loopback safety, but reject rather than silently go direct.
    if (!proxyForUrl(this.policy, String(options.origin))) throw new SessionProxyRouteError('The configured proxy has no route for this destination; direct fallback is forbidden.')
    return super.dispatch(options, handler)
  }
}
