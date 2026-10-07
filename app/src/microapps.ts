import { t } from './i18n.ts'
import { z } from 'zod'
import { appRecordSchema } from '../../src/microapps/contracts.ts'
import { apiUrl } from './api-url.ts'
import { parseMicroAppIdentity } from '../../desktop/src/micro-app-contract.ts'

export const microAppView = appRecordSchema.extend({
  status: z.enum(['awaiting_approval', 'starting', 'running', 'stopped', 'failed', 'interrupted']),
  uiPath: z.string(),
  cleanupPending: z.boolean().optional(),
  acceptanceAvailable: z.boolean().optional(),
})
export const microAppReview = microAppView.extend({
  files: z.array(z.object({ path: z.string(), bytes: z.number(), text: z.string().optional() })),
})
export type MicroAppView = z.infer<typeof microAppView>
export type MicroAppReview = z.infer<typeof microAppReview>

export function nativeAppIdentity(base: string, id: string) {
  const path = new URL(base).pathname
  const match = /^\/projects\/([a-zA-Z0-9_-]{1,128})\/?$/.exec(path)
  if (!match) throw new Error(t('A Project-scoped app is required'))
  return parseMicroAppIdentity({ projectId: match[1], appId: id })
}

export function microAppIconUrl(base: string, app: MicroAppView): string | undefined {
  return app.manifest.icon ? apiUrl(base, `/api/microapps/${app.id}/icon`, { revision: app.revision }).href : undefined
}

export function validAppLaunch(value: unknown): string {
  const { url } = z.object({ url: z.string().url() }).passthrough().parse(value)
  const parsed = new URL(url)
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || !parsed.port
    || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search
    || !/^#shadow_ticket=[A-Za-z0-9_-]{43}$/.test(parsed.hash)) throw new Error(t('Invalid local app launch URL'))
  return url
}

export async function microAppRequest(base: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const response = await fetch(apiUrl(base, `/api/microapps${path}`), {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
  })
  const value: unknown = await response.json()
  if (!response.ok) throw new Error(value && typeof value === 'object' && 'message' in value && typeof value.message === 'string'
    ? value.message : t('Apps request failed (HTTP {status}). Reload and check Project access.', { status: response.status }))
  return value
}
export const microAppStatus: Record<MicroAppView['status'], string> = {
  get awaiting_approval() { return t('Needs review') }, get starting() { return t('Starting') }, get running() { return t('Running') },
  get stopped() { return t('Stopped') }, get failed() { return t('Failed') }, get interrupted() { return t('Interrupted') },
}
export const microAppTestingStatus: Record<NonNullable<MicroAppView['acceptance']>['status'], string> = {
  get asking() { return t('Waiting for your choice') }, get paused() { return t('Testing paused') }, get dispatching() { return t('Notifying the author') },
  get notified() { return t('Queued for the author') }, get running() { return t('Author is working') }, get testing() { return t('Runtime testing started') },
  get blocked() { return t('Author reported a Work blocker') }, get incomplete() { return t('Author finished without a report') },
  get failed() { return t('Testing handoff or author turn failed') }, get interrupted() { return t('Testing interrupted') }, get reported() { return t('Report saved') },
}
