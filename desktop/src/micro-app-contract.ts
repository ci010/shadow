export interface MicroAppIdentity {
  readonly projectId: string
  readonly appId: string
}

export interface DesktopMicroAppsApi {
  open(identity: MicroAppIdentity): Promise<void>
  refresh(): Promise<void>
}

export const MICRO_APP_CHANNELS = { open: 'shadow:micro-apps:open', refresh: 'shadow:micro-apps:refresh' } as const
const projectPattern = /^[a-zA-Z0-9_-]{1,128}$/
const appPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function parseMicroAppIdentity(value: unknown): MicroAppIdentity {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'projectId' && key !== 'appId')
    || typeof value.projectId !== 'string' || !projectPattern.test(value.projectId)
    || typeof value.appId !== 'string' || !appPattern.test(value.appId)) {
    throw new TypeError('Micro App launch requires a Project ID and app UUID, not a URL or credential')
  }
  return { projectId: value.projectId, appId: value.appId.toLowerCase() }
}

export function microAppArgument(identity: MicroAppIdentity): string {
  const valid = parseMicroAppIdentity(identity)
  return `--shadow-micro-app=${valid.projectId}:${valid.appId}`
}

export function parseMicroAppArguments(argv: readonly string[]): MicroAppIdentity | undefined {
  const matches = argv.filter(arg => arg === '--shadow-micro-app' || arg.startsWith('--shadow-micro-app='))
  if (!matches.length) return undefined
  if (matches.length !== 1 || !matches[0]!.startsWith('--shadow-micro-app=')) throw new TypeError('Invalid Micro App launch argument')
  const parts = matches[0]!.slice('--shadow-micro-app='.length).split(':')
  if (parts.length !== 2) throw new TypeError('Invalid Micro App launch identity')
  return parseMicroAppIdentity({ projectId: parts[0], appId: parts[1] })
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export interface NativeMicroApp {
  id: string
  revision: string
  name: string
  icon: boolean
  approved: boolean
  status: string
}

export function parseNativeMicroApp(value: unknown): NativeMicroApp {
  if (!isRecord(value) || typeof value.id !== 'string' || !appPattern.test(value.id)
    || typeof value.revision !== 'string' || !/^[a-f0-9]{64}$/.test(value.revision)
    || !isRecord(value.manifest) || typeof value.manifest.name !== 'string'
    || !value.manifest.name.trim() || value.manifest.name.length > 100
    || (value.manifest.icon !== undefined && (typeof value.manifest.icon !== 'string' || !value.manifest.icon.toLowerCase().endsWith('.png')))
    || typeof value.status !== 'string' || !['awaiting_approval', 'starting', 'running', 'stopped', 'failed', 'interrupted'].includes(value.status)
    || (value.approval !== undefined && (!isRecord(value.approval) || value.approval.revision !== value.revision))) {
    throw new TypeError('Invalid Micro App catalog response')
  }
  return { id: value.id.toLowerCase(), revision: value.revision, name: value.manifest.name,
    icon: value.manifest.icon !== undefined, approved: value.approval !== undefined, status: value.status }
}

export function parseMicroAppLaunch(value: unknown): string {
  if (!isRecord(value) || typeof value.url !== 'string') throw new TypeError('Invalid Micro App launch response')
  const url = new URL(value.url)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password
    || url.pathname !== '/' || url.search || !/^#shadow_ticket=[A-Za-z0-9_-]{43}$/.test(url.hash)) {
    throw new TypeError('Invalid local Micro App launch URL')
  }
  return url.href
}
