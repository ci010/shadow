import { createHash, randomBytes } from 'node:crypto'
import { deviceChallengeApiPlugin } from './device-challenge-api.ts'
import { decodeDeviceChallengeProtocol } from './device-challenge.ts'
import type { MainCluster } from './main-cluster.ts'
import type { ApprovedNodeV1 } from './contracts.ts'
import type { DeviceAuthenticationV1 } from './registry.ts'
import { GLTF_CAPTURE_PATH } from '../gltf-capture-contract.ts'
import type { GatewayPlugin } from '../gateway/types.ts'

export const DEVICE_UI_SESSION = '/cluster/v1/ui/session'
export const DEVICE_UI_SESSION_CHALLENGE = '/cluster/v1/ui/session-challenges'
export const DIRECT_DEVICE_UI_ROUTES = [
  { method: 'POST', path: DEVICE_UI_SESSION }, { method: 'POST', path: DEVICE_UI_SESSION_CHALLENGE },
] as const
const lifetimeMs = 30 * 60_000
const maxGrants = 256
const hash = (token: string) => createHash('sha256').update(token).digest('base64url')
const epoch = (node: ApprovedNodeV1) => JSON.stringify([node.credentialId, node.deviceIdentityFingerprint, node.approvedAt])

function sessionAudience(value: string) {
  const url = new URL(value)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = DEVICE_UI_SESSION
  url.search = ''; url.hash = ''
  return url.href
}

// A paired workspace is not an owner/admin principal. Keep sensitive host
// configuration and device enrollment off this credential even inside Projects.
export function directDeviceUiPath(path: string, method: string): boolean {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\') || /%2f|%5c|%2e/i.test(path)) return false
  const bare = path.replace(/^\/projects\/[^/]+(?=\/)/, '')
  if (bare === '/nodes/v1') return method === 'GET'
  if (bare === '/api/live/ws') return method === 'POST' // Device upgrades require the one-use ticket.
  if (/^\/api\/agent-types(?:\/|$)/.test(bare)) {
    return ['GET', 'HEAD'].includes(method) && /^\/api\/agent-types(?:\/[^/]+\/context)?\/?$/.test(bare)
  }
  if (!/^\/(?:api(?:\/|$)|(?:host\/)?v1\/query(?:\/|$))/.test(bare)) return false
  if (/^\/api\/(?:auth|deepseek-account|credentials|credential-requests|web-auth|mobile)(?:\/|$)/.test(bare)) return false
  // The strictly validated project model-defaults patch does not change host or credential settings.
  if (bare === '/api/config/model-defaults' && path.startsWith('/projects/') && method === 'PATCH') return true
  if (/^\/api\/(?:config|app|providers?|provider-setup|settings)(?:\/|$)/.test(bare)) {
    return ['GET', 'HEAD'].includes(method)
  }
  return true
}

export function directDeviceCapturePath(request: Request) {
  const path = new URL(request.url).pathname.replace(/^\/projects\/[^/]+(?=\/)/, '')
  return request.method === 'POST' && (path === '/api/chat/send' || (path.startsWith(`${GLTF_CAPTURE_PATH}/`) &&
    ['register', 'poll', 'version', 'result', 'unregister'].includes(path.slice(GLTF_CAPTURE_PATH.length + 1))))
}

interface Grant {
  readonly authentication: DeviceAuthenticationV1
  readonly epoch: string
  readonly audience: string
  readonly expiresAt: number
  readonly lifetime: AbortController
}

export class DirectDeviceUi {
  private readonly grants = new Map<string, Grant>()
  private readonly timer: ReturnType<typeof setInterval>
  private readonly stopObserving: () => void
  constructor(private readonly cluster: MainCluster, private readonly enabled: () => boolean, private readonly now = Date.now) {
    this.timer = setInterval(() => this.prune(), 1000)
    this.timer.unref()
    this.stopObserving = cluster.observeInventory(() => this.prune())
  }
  private approved(authentication: DeviceAuthenticationV1): ApprovedNodeV1 | undefined {
    if (!this.enabled()) return
    try { return this.cluster.registry.authenticate(authentication) } catch { return undefined }
  }
  private prune() {
    for (const [key, grant] of this.grants) {
      const node = this.approved(grant.authentication)
      if (!node || epoch(node) !== grant.epoch || grant.expiresAt <= this.now()) {
        this.grants.delete(key)
        grant.lifetime.abort()
      }
    }
  }
  reset() {
    for (const grant of this.grants.values()) grant.lifetime.abort()
    this.grants.clear()
  }
  close() { this.stopObserving(); clearInterval(this.timer); this.reset() }
  hasCredential(request: Request) { return /^ShadowDevice(?: |$)/i.test(request.headers.get('authorization') ?? '') }
  private admit(request: Request) {
    const token = /^ShadowDevice ([A-Za-z0-9_-]{43})$/.exec(request.headers.get('authorization') ?? '')?.[1]
    const url = new URL(request.url)
    if (!token || !directDeviceUiPath(url.pathname, request.method)) return
    const grant = this.grants.get(hash(token))
    if (!grant || grant.audience !== url.origin || grant.expiresAt <= this.now() || grant.lifetime.signal.aborted) return
    const node = this.approved(grant.authentication)
    if (node && epoch(node) === grant.epoch) return { grant, node }
  }
  authorize = (request: Request): boolean => !!this.admit(request)
  ownerSignal = (request: Request): AbortSignal | undefined => this.admit(request)?.grant.lifetime.signal
  captureSignal = (request: Request): AbortSignal | undefined => directDeviceCapturePath(request) ? this.ownerSignal(request) : undefined
  displayName = (request: Request): string | undefined => this.admit(request)?.node.displayName
  plugin(): GatewayPlugin {
    const audience = sessionAudience
    return app => {
      app.use('/cluster/v1/ui/session*', async (c, next) => {
        c.header('Cache-Control', 'no-store')
        if (!this.enabled()) return c.notFound()
        await next()
      })
      deviceChallengeApiPlugin({ authority: this.cluster.authority, path: DEVICE_UI_SESSION_CHALLENGE,
        audience, requestsPerMinute: 600, clientKey: request => new URL(request.url).host })(app)
      app.post(DEVICE_UI_SESSION, async c => {
        const proof = decodeDeviceChallengeProtocol(c.req.header('X-Shadow-Device-Proof') ?? '')
        const authentication = proof && await this.cluster.authority.verify(proof, audience(c.req.url))
        const node = authentication && this.approved(authentication)
        if (!node) return c.json({ error: 'device_ui_unauthorized' }, 401)
        this.prune()
        const sameDevice = [...this.grants].filter(([, grant]) => grant.authentication.credentialId === authentication.credentialId)
        // Bound grant churn per device so one paired peer cannot exhaust all slots.
        for (const [key, grant] of sameDevice.slice(0, Math.max(0, sameDevice.length - 3))) {
          this.grants.delete(key)
          grant.lifetime.abort()
        }
        if (this.grants.size >= maxGrants) return c.json({ error: 'device_ui_capacity' }, 429)
        const token = randomBytes(32).toString('base64url')
        const expiresAt = this.now() + lifetimeMs
        this.grants.set(hash(token), { authentication, epoch: epoch(node), expiresAt,
          audience: new URL(c.req.url).origin, lifetime: new AbortController() })
        return c.json({ version: 1, token, expiresAt })
      })
    }
  }
}
