import { t } from '../i18n.ts'
import { apiUrl, hostBase } from '../api-url.ts'
import type { InstallationContextV1 } from '../installation-context.ts'

export interface DeviceNetwork {
  version: 1
  enabled: boolean
  host: string
  port: number
  allowInsecureLocalTransport: boolean
  state: 'disabled' | 'listening' | 'error'
  endpoint: string | null
  error: string | null
  addresses: Array<{ name: string; address: string }>
}

export interface DeviceInvitation {
  version: 1
  offerId: string
  pin: string
  expiresAt: string
}

export interface PendingDevice {
  version: 1
  pendingId: string
  deviceId: string
  nodeId: string
  credentialId?: string
  deviceIdentityFingerprint: string
  displayName: string
  requestedAt: string
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const identifier = (value: unknown): value is string => text(value) && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
const timestamp = (value: unknown): value is string => text(value) && Number.isFinite(Date.parse(value))
const invalid = () => new Error(t('The backend returned invalid device administration data. Update Shadow and retry.'))

export class DeviceAdministrationAccessError extends Error {
  constructor() {
    super(t('Device administration requires the authorized Main desktop app. Open Nodes there and retry. Browser sign-in does not grant device administration access.'))
    this.name = 'DeviceAdministrationAccessError'
  }
}

export function canAdministerDevices(context: { mode: InstallationContextV1['mode']; uiScopes: readonly InstallationContextV1['uiScopes'][number][] }): boolean {
  return context.mode === 'main' && context.uiScopes.includes('nodes:admin')
}

export function isLocalDeviceAddress(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4 || parts.some(part => !/^(0|[1-9]\d{0,2})$/.test(part) || Number(part) > 255)) return false
  const [a, b] = parts.map(Number)
  return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31)
    || (a === 192 && b === 168) || (a === 169 && b === 254)
    || (a === 100 && b! >= 64 && b! <= 127)
}

export function deviceHostChoices(network: DeviceNetwork): DeviceNetwork['addresses'] {
  return network.addresses.filter(({ address }, index, values) =>
    isLocalDeviceAddress(address) && values.findIndex(value => value.address === address) === index)
}

export function defaultDeviceHost(network: DeviceNetwork): string {
  const choices = deviceHostChoices(network)
  return choices.find(choice => choice.address === network.host && network.enabled)?.address
    ?? choices.find(choice => !choice.address.startsWith('127.'))?.address
    ?? choices[0]?.address ?? ''
}

export function parseDeviceNetwork(value: unknown): DeviceNetwork {
  if (!record(value) || value.version !== 1 || typeof value.enabled !== 'boolean'
    || !text(value.host) || !isLocalDeviceAddress(value.host)
    || !Number.isInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535
    || typeof value.allowInsecureLocalTransport !== 'boolean'
    || !['disabled', 'listening', 'error'].includes(String(value.state))
    || !(value.endpoint === null || text(value.endpoint))
    || !(value.error === null || typeof value.error === 'string') || !Array.isArray(value.addresses)
    || value.addresses.some(address => !record(address) || !text(address.name) || !text(address.address))) throw invalid()
  if (value.endpoint !== null) {
    let url: URL
    try { url = new URL(value.endpoint) } catch { throw invalid() }
    if (url.protocol !== 'http:' || url.hostname !== value.host || Number(url.port) !== value.port || url.username || url.password
      || url.search || url.hash || url.pathname !== '/') throw invalid()
  }
  if (value.state === 'listening' && (!value.enabled || !value.endpoint || !value.allowInsecureLocalTransport)) throw invalid()
  if (value.state !== 'listening' && value.endpoint !== null) throw invalid()
  if (value.state === 'error' ? !text(value.error) : value.error !== null) throw invalid()
  return value as unknown as DeviceNetwork
}

export function parseDeviceInvitation(value: unknown): DeviceInvitation {
  if (!record(value) || value.version !== 1 || !identifier(value.offerId)
    || typeof value.pin !== 'string' || !/^\d{6}$/.test(value.pin) || !timestamp(value.expiresAt)) throw invalid()
  return { version: 1, offerId: value.offerId, pin: value.pin, expiresAt: value.expiresAt }
}

export function parsePendingDevices(value: unknown): PendingDevice[] {
  if (!record(value) || value.version !== 1 || !Array.isArray(value.pending)) throw invalid()
  const ids = new Set<string>()
  return value.pending.map(item => {
    if (!record(item) || item.version !== 1 || !identifier(item.pendingId) || ids.has(item.pendingId)
      || !identifier(item.deviceId) || !identifier(item.nodeId)
      || (item.credentialId !== undefined && !identifier(item.credentialId))
      || !text(item.deviceIdentityFingerprint) || item.deviceIdentityFingerprint.length < 16
      || item.deviceIdentityFingerprint.length > 256 || !text(item.displayName) || !timestamp(item.requestedAt)) throw invalid()
    ids.add(item.pendingId)
    return item as unknown as PendingDevice
  })
}

export function invitationRemaining(invitation: DeviceInvitation, now: number): number {
  return Math.max(0, Math.ceil((Date.parse(invitation.expiresAt) - now) / 1000))
}

export function deviceApprovalBody(pending: PendingDevice, verified: boolean, consented: boolean) {
  if (!verified || !consented) throw new Error(t('Verify the fingerprint and authorize execution before approving.'))
  if (!pending.credentialId) throw new Error(t('This device request has no credential identity. Pair again from an updated Child.'))
  return { version: 1, expectedDeviceIdentityFingerprint: pending.deviceIdentityFingerprint }
}

export function validateDeviceApproval(value: unknown, pending: PendingDevice): void {
  if (!record(value) || value.version !== 1 || value.deviceId !== pending.deviceId
    || value.nodeId !== pending.nodeId || value.credentialId !== pending.credentialId) throw invalid()
}

export async function revokeDevice(apiBase: string, nodeId: string, signal: AbortSignal): Promise<void> {
  const value = await deviceAdminRequest(apiBase, `/nodes/v1/${encodeURIComponent(nodeId)}/revoke`, signal, 'POST')
  if (!record(value) || value.version !== 1 || value.nodeId !== nodeId || value.state !== 'revoked') throw invalid()
}

export async function deviceAdminRequest(
  apiBase: string,
  path: string,
  signal: AbortSignal,
  method = 'GET',
  body?: unknown,
  request: typeof fetch = fetch,
): Promise<unknown> {
  const response = await request(apiUrl(hostBase(apiBase), path), {
    method, signal, cache: 'no-store', redirect: 'error',
    headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401 || response.status === 403) {
    throw new DeviceAdministrationAccessError()
  }
  const json = response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() === 'application/json'
  if (response.status === 404 && path.includes('/pending/')) {
    throw new Error(t('This pairing request is no longer pending. Refresh devices before trying again.'))
  }
  if (path.endsWith('/revoke')) {
    if (response.status === 404) throw new Error(t('This device or the removal endpoint is unavailable. Refresh devices and check that Main is up to date.'))
    if (response.status === 503) throw new Error(t('Device removal could not be saved or completed. It may already be disconnected. Retry removal before restarting Main.'))
  }
  if (response.status === 404 || response.status === 501 || (response.ok && !json)) {
    throw new Error(t('Device administration is unavailable. Restart Main after updating Shadow, then retry.'))
  }
  if (response.status === 503 && path === '/nodes/v1/network' && method === 'PUT' && json) {
    const failure: unknown = await response.json()
    if (record(failure) && failure.error === 'device_listener_failed') {
      const network = parseDeviceNetwork(failure.network)
      if (network.state === 'error') return network
    }
  }
  if (!response.ok) throw new Error(t('Device request failed ({status}). Refresh and retry; check Main if the problem continues.', { status: response.status }))
  try { return await response.json() } catch (cause) {
    if (cause instanceof SyntaxError) throw invalid()
    throw cause
  }
}
