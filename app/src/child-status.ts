import { t } from './i18n.ts'
export interface ChildStatus {
  readonly version: 1
  readonly nodeId: string
  readonly mainEndpoint: string
  readonly connection: 'connecting' | 'connected' | 'offline'
  readonly error: string | null
  readonly fingerprint: string
  readonly dataDir: string
  readonly workdirs: readonly { capabilityId: string; rootPath: string; displayName: string }[]
  readonly allowInsecureLocalTransport: boolean
}

export function parseChildStatus(value: unknown): ChildStatus {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(t('Child status is invalid'))
  const v = value as Record<string, unknown>
  if (v.version !== 1 || !['connecting', 'connected', 'offline'].includes(String(v.connection))
    || !['nodeId', 'mainEndpoint', 'fingerprint', 'dataDir'].every(key => typeof v[key] === 'string' && v[key])
    || (v.error !== null && typeof v.error !== 'string') || typeof v.allowInsecureLocalTransport !== 'boolean'
    || !Array.isArray(v.workdirs) || !v.workdirs.every(item => item && typeof item === 'object'
      && ['capabilityId', 'rootPath', 'displayName'].every(key => typeof item[key] === 'string'))) {
    throw new Error(t('Child status is invalid'))
  }
  return v as unknown as ChildStatus
}
