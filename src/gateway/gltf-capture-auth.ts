import { isLoopbackGatewayRequest, validateLaunchCredential, type GatewayClientAddressRegistry } from './server.ts'
import type { GltfCaptureOwner } from './gltf-capture.ts'

/** Capture binds to the trusted desktop launch or to a specialized device grant,
 * never to general delegated/mobile authentication. */
export function createGltfCaptureOwner(options: {
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
    if (!isLoopbackGatewayRequest(request, options.clientAddresses)) return
    const approvedOrigin = origin === new URL(request.url).origin || origin === developmentOrigin
    const authorization = request.headers.get('Authorization') ?? undefined
    if (options.launchCredential) {
      // Packaged file:// Electron and a configured dev renderer can legitimately
      // be cross-site. Only the exact launch bearer permits those origins.
      if ((approvedOrigin || origin === 'null') && await validateLaunchCredential(authorization, options.launchCredential)) return localOwner
    }
  }
}
