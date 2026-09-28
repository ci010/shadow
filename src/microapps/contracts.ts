import { z } from 'zod'

export const MAX_BUNDLE_BYTES = 16 * 1024 * 1024
export const MAX_FILE_BYTES = 4 * 1024 * 1024
export const MAX_ICON_BYTES = 256 * 1024
export const MAX_STATE_BYTES = 64 * 1024
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
const jsonValue: z.ZodType<JsonValue> = z.lazy(() => z.union([
  z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue),
]))
export const appStateSchema = z.object({
  version: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 1),
  values: z.record(jsonValue),
}).strict()
export type AppState = z.infer<typeof appStateSchema>
export const microAppCapabilities = {
  version: 1,
  approval: { execution: 'owner-approved-revision', agentMayApprove: false },
  model: { input: 'text-only', maxConcurrentCalls: 2, failedAttemptsConsumeAllowance: true },
  storage: {
    browserPartition: 'ephemeral-per-native-window',
    state: { persistent: true, scope: 'project-and-app', maxBytes: MAX_STATE_BYTES,
      concurrency: 'expected-version', sdk: ['loadState', 'saveState'] },
    backendPersistentDirectory: 'SHADOW_APP_DATA',
    backendTemporaryDirectory: 'SHADOW_APP_TEMP',
    temporaryCleanup: 'after-owned-processes-stop',
    crashCleanupGuaranteed: false,
  },
  backend: { runtimes: ['node', 'python'], automaticDependencyInstall: false,
    healthDeadlineMs: 15_000, maxTransferBytes: 16 * 1024 * 1024, timeoutMs: 180_000, osSandbox: false,
    nodeFetchProxy: 'standard-env-or-windows-static-with-bypass',
    proxyCredentialsForwarded: false, automaticProxyScriptsSupported: false },
  sdk: { requestErrors: 'AppRequestError with status and code; non-2xx throws' },
} as const
export const appId = z.string().uuid()
export const revisionId = z.string().regex(/^[a-f0-9]{64}$/)
export const appPath = z.string().min(1).max(240).refine(value =>
  !value.includes('\\') && !value.includes(':') && value.split('/').every(part =>
    !!part && part !== '.' && part !== '..' && !part.startsWith('.') && !/[. ]$/.test(part)
    && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) && !/["<>|?*\u0000-\u001f]/.test(part)),
'Use a relative slash-separated path without hidden files, traversal or platform-special characters')
export const appManifestSchema = z.object({
  version: z.literal(1),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().min(1).max(2000),
  entry: appPath.refine(value => value.endsWith('.html'), 'entry must be an HTML file'),
  icon: appPath.refine(value => value.toLowerCase().endsWith('.png'), 'App icons must be PNG files').optional(),
  files: z.array(appPath).min(1).max(128),
  backend: z.object({
    runtime: z.enum(['node', 'python']),
    entry: appPath,
    args: z.array(z.string().max(1000)).max(20).default([]),
  }).strict().optional(),
  llm: z.object({
    maxCalls: z.number().int().min(1).max(10_000),
    maxOutputTokens: z.number().int().min(1).max(8192),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  const names = value.files.map(name => name.toLowerCase())
  if (new Set(names).size !== names.length) ctx.addIssue({ code: 'custom', message: 'File paths must be unique, including case' })
  if (!value.files.includes(value.entry)) ctx.addIssue({ code: 'custom', path: ['entry'], message: 'Entry must be in files' })
  if (value.icon && !value.files.includes(value.icon)) ctx.addIssue({ code: 'custom', path: ['icon'], message: 'Icon must be in files' })
  if (value.backend && (!value.files.includes(value.backend.entry) || value.backend.entry === value.entry)) {
    ctx.addIssue({ code: 'custom', path: ['backend', 'entry'], message: 'Backend needs its own file in files' })
  }
  if (value.files.some(name => name.split('/')[0] === '_shadow' || name.split('/')[0] === 'backend')) {
    ctx.addIssue({ code: 'custom', message: '_shadow and backend URL prefixes are reserved; name the server file server.py or server.mjs' })
  }
})
export type AppManifest = z.infer<typeof appManifestSchema>
export const bundleSchema = z.object({
  manifest: appManifestSchema,
  files: z.record(z.string()),
}).strict()
export type AppBundle = z.infer<typeof bundleSchema>
export const appRecordSchema = z.object({
  version: z.literal(1), id: appId, revision: revisionId, manifest: appManifestSchema,
  createdBy: z.string().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  approval: z.object({ revision: revisionId, at: z.string().datetime(), model: z.string().min(1).optional() }).strict().optional(),
  calls: z.number().int().nonnegative().default(0),
  lastRun: z.object({
    id: z.string().uuid(), status: z.enum(['starting', 'running', 'stopped', 'failed', 'interrupted']),
    error: z.string().optional(),
  }).strict().optional(),
}).strict()
export type AppRecord = z.infer<typeof appRecordSchema>
export const generationSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(['system', 'user', 'assistant']), content: z.string().max(32_000),
  }).strict()).min(1).max(40),
  maxTokens: z.number().int().min(1).max(8192).optional(),
}).strict().refine(value => value.messages.reduce((total, message) => total + message.content.length, 0) <= 64_000,
'At most 64000 input characters per request')

export class MicroAppError extends Error {
  constructor(readonly code: string, message: string, readonly status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 502 = 400) {
    super(message)
  }
}
