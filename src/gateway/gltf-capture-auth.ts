import { isLoopbackGatewayRequest, validateLaunchCredential, type GatewayClientAddressRegistry } from './server.ts'
import type { BrowserAuth } from './web-auth.ts'
import type { GltfCaptureOwner } from './gltf-capture.ts'

/** A browser cookie has revocable identity. The desktop launch credential has
 * process lifetime and is injected only into the trusted top-level renderer.
 * Only the specialized proof-bound device principal may bind its own Viewer;
 * general device or mobile authentication is not owner authorization. */
export function createGltfCaptureOwner(options: {
  browser: Pick<BrowserAuth, 'required' | 'session'>
  clientAddresses: GatewayClientAddressRegistry
  launchCredential?: string
  developmentUrl?: string
  deviceViewer?(request: Request): AbortSignal | undefined
  delegated(request: Request): boolean
}): GltfCaptureOwner {
  const localOwner = {}
  let developmentOrigin: string | undefined
  try { if (options.developmentUrl) developmentOrigin = new URL(options.developmentUrl).origin } catch { /* Invalid dev URL is never trusted. */ }
  return async request => {
    const device = options.deviceViewer?.(request)
    if (device && !device.aborted) return device
    const origin = request.headers.get('origin')
    if (!origin || options.delegated(request)) return
    const browser = options.browser.session(request)
    if (browser && !browser.controller.signal.aborted) return browser.controller.signal
    if (!isLoopbackGatewayRequest(request, options.clientAddresses)) return
    const approvedOrigin = origin === new URL(request.url).origin || origin === developmentOrigin
    const authorization = request.headers.get('Authorization') ?? undefined
    if (options.launchCredential) {
      // Packaged file:// Electron and a configured dev renderer can legitimately
      // be cross-site. Only the exact launch bearer permits those origins.
      if ((approvedOrigin || origin === 'null') && await validateLaunchCredential(authorization, options.launchCredential)) return localOwner
    } else if (approvedOrigin && request.headers.get('sec-fetch-site') !== 'cross-site' && !options.browser.required && !authorization) {
      return localOwner
    }
  }
}
