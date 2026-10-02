import { z } from 'zod'
import { decisionEvidenceSchema } from '../sessions/decision-brief.ts'

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
  acceptance: { afterApproval: 'ask-local-owner', timeoutMs: 60_000, default: 'continue-testing',
    scope: 'approved-revision-only', open: 'author-owned-browser', reports: 'agent-assessment-with-host-observations',
    categories: ['startup', 'state', 'recovery', 'reopen'], deviceAuthorization: 'unchanged',
    requirements: 'published-work-acceptance-snapshot; report each criterion, including blocked/not_tested',
    evidence: 'action:evidence resolves own recorded tool IDs and exact excerpts into canonical report references',
    handoff: 'queued-notification, author-turn, runtime-testing, terminal-report-or-explicit-missing-report' },
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
export const appObservationSchema = z.object({
  id: z.string().uuid(), runId: z.string().uuid(),
  kind: z.enum(['started', 'startup_failed', 'sdk_connected', 'state_read', 'state_saved',
    'model_completed', 'model_failed', 'model_cancelled', 'backend_completed', 'backend_failed', 'backend_cancelled',
    'stopped', 'interrupted']),
  firstAt: z.string().datetime(), lastAt: z.string().datetime(), count: z.number().int().positive(),
  firstSequence: z.number().int().positive(), lastSequence: z.number().int().positive(),
  stateVersion: z.number().int().nonnegative().optional(),
}).strict()
const appCheckSchema = z.object({
  result: z.enum(['passed', 'failed', 'blocked', 'not_tested']),
  basis: z.enum(['runtime', 'fixture', 'not_tested']),
  summary: z.string().trim().min(1).max(2000),
  observations: z.array(z.string().uuid()).max(20),
  evidence: z.array(decisionEvidenceSchema.extend({ kind: z.literal('tool') })).max(6),
}).strict()
export const appWorkScopeSchema = z.object({
  key: z.string().min(1).max(600), revision: z.number().int().positive(),
  acceptance: z.array(z.string().min(1).max(4000)).min(1).max(12),
}).strict()
export type AppWorkScope = z.infer<typeof appWorkScopeSchema>
export const appTestReportSchema = z.object({
  checks: z.array(appCheckSchema.extend({
    category: z.enum(['startup', 'state', 'recovery', 'reopen', 'business', 'device']),
  })).min(4).max(6),
  requirements: z.array(appCheckSchema.extend({
    workKey: z.string().min(1).max(600), workRevision: z.number().int().positive(),
    criterion: z.number().int().nonnegative().max(11),
  })).max(240).optional(),
}).strict().superRefine(({ checks, requirements }, ctx) => {
  const categories: string[] = checks.map(check => check.category)
  if (new Set(categories).size !== checks.length ||
    ['startup', 'state', 'recovery', 'reopen'].some(category => !categories.includes(category))) {
    ctx.addIssue({ code: 'custom', path: ['checks'], message: 'Include startup, state, recovery and reopen exactly once; business/device are optional.' })
  }
  for (const [collection, items] of [['checks', checks], ['requirements', requirements ?? []]] as const) {
    for (const [index, check] of items.entries()) {
      if (check.result === 'passed' && check.basis === 'not_tested') {
        ctx.addIssue({ code: 'custom', path: [collection, index, 'basis'], message: 'Passed checks cannot use a not_tested basis.' })
      }
      if (check.result === 'passed' && !check.evidence.length) {
        ctx.addIssue({ code: 'custom', path: [collection, index, 'evidence'], message: 'Passed checks need recorded tool evidence.' })
      }
      if (check.basis === 'runtime' && !check.observations.length) {
        ctx.addIssue({ code: 'custom', path: [collection, index, 'observations'],
          message: 'Runtime basis requires host observations, even for blocked/failed results. Cite IDs from get.acceptance or use the basis actually exercised.' })
      }
    }
  }
})
export type AppTestReport = z.infer<typeof appTestReportSchema>
export const appAcceptanceSchema = z.object({
  id: z.string().uuid(), revision: revisionId, approvalAt: z.string().datetime(),
  status: z.enum(['asking', 'paused', 'dispatching', 'notified', 'running', 'testing', 'blocked', 'incomplete', 'failed', 'interrupted', 'reported']),
  authorTurn: z.object({
    id: z.string().min(1), startedAt: z.string().datetime(), finishedAt: z.string().datetime().optional(),
    outcome: z.enum(['completed', 'failed', 'cancelled']).optional(),
  }).strict().optional(),
  work: z.array(appWorkScopeSchema).max(20).optional(),
  decisionSessionId: z.string().min(1).optional(),
  decisionRequestId: z.string().min(1).optional(),
  decision: z.enum(['user', 'timeout']).optional(),
  error: z.string().max(1000).optional(),
  sequence: z.number().int().nonnegative().default(0),
  observations: z.array(appObservationSchema).max(128), observationsTruncated: z.boolean().optional(),
  report: z.object({ at: z.string().datetime(), sessionId: z.string().min(1), result: appTestReportSchema }).strict().optional(),
}).strict()
export type AppAcceptance = z.infer<typeof appAcceptanceSchema>
export type AppObservation = z.infer<typeof appObservationSchema>
export const appRecordSchema = z.object({
  version: z.literal(1), id: appId, revision: revisionId, manifest: appManifestSchema,
  createdBy: z.string().min(1), createdAt: z.string().datetime(), updatedAt: z.string().datetime(),
  approval: z.object({ revision: revisionId, at: z.string().datetime(), model: z.string().min(1).optional() }).strict().optional(),
  calls: z.number().int().nonnegative().default(0),
  work: z.array(appWorkScopeSchema).max(20).optional(),
  acceptance: appAcceptanceSchema.optional(),
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
