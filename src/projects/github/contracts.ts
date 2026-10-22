import { z } from 'zod'
import { workDefinitionSchema } from '../../initiatives/work-contract.ts'

const id = z.string().min(1).max(600)
export const repositoryName = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9-]*\/[a-zA-Z0-9_.-]+$/).refine(value => !value.split('/').includes('..'))
const text = z.string().trim().min(1).max(65536)
const sha = z.string().regex(/^[a-f0-9]{40,64}$/)
const timestamp = z.string().datetime({ offset: true })
const githubUrl = z.string().url().refine(value => {
  const url = new URL(value)
  return url.origin === 'https://github.com' && !url.username && !url.password
}, 'Expected a GitHub URL.')
export const githubRepositorySchema = z.object({
  id, name: repositoryName, read: z.boolean(), write: z.boolean(),
}).strict()
export const githubSnapshotSchema = z.object({
  id, repositoryId: id, repository: repositoryName, number: z.number().int().positive(),
  kind: z.enum(['issue', 'pr']), url: githubUrl, title: text, body: z.string().max(65536),
  state: z.enum(['open', 'closed', 'merged']), updatedAt: timestamp, fetchedAt: timestamp, sourceHash: id, fingerprint: id,
  head: sha.optional(), base: sha.optional(), draft: z.boolean().optional(),
  ci: z.enum(['none', 'pending', 'success', 'failure']).optional(),
  review: z.enum(['none', 'approved', 'changes_requested', 'commented']).optional(),
  checkFingerprint: id.optional(),
  reviews: z.array(z.object({ id: z.number().int().positive(), author: id, body: z.string().max(65536),
    state: id, commit: sha.nullable(), submittedAt: timestamp })).default([]),
  comments: z.array(z.object({ id: z.number().int().positive(), author: id, body: z.string().max(65536), updatedAt: timestamp,
    inline: z.boolean(), inReplyTo: z.number().int().positive().optional() })),
}).strict()
export const githubLinkSchema = z.object({
  resourceId: id, workKey: id, sourceHash: id, linkedAt: timestamp,
}).strict()
const branch = z.string().min(1).max(250).refine(value => !/[\s~^:?*[\]\\]/.test(value) && !value.includes('..') && !value.startsWith('-'), 'Use a branch name, not a revision expression.')
export const githubOperationInput = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('comment'), resourceId: id, workKey: id, body: text }).strict(),
  z.object({ kind: z.literal('reply'), resourceId: id, workKey: id, commentId: z.number().int().positive(), body: text }).strict(),
  z.object({ kind: z.literal('close_issue'), resourceId: id, workKey: id, reason: z.enum(['completed', 'not_planned']) }).strict(),
  z.object({ kind: z.literal('create_pr'), repositoryId: id, workKey: id, head: branch, base: branch,
    title: z.string().trim().min(1).max(160), body: text, draft: z.boolean() }).strict(),
])
export const githubOperationSchema = z.object({
  id: z.string().uuid(), input: githubOperationInput, repositoryId: id,
  targetUrl: githubUrl,
  workRevision: z.number().int().positive(), workSequence: z.number().int().positive(),
  targetFingerprint: id, head: sha.optional(), base: sha.optional(), createdAt: timestamp,
  status: z.enum(['preview', 'sending', 'succeeded', 'unknown', 'reconciled', 'cancelled', 'not_applied']),
  receipt: githubUrl.optional(), error: z.string().optional(),
}).strict()
export const githubSubscriptionSchema = z.object({
  resourceId: id, workKey: id, sessionId: id, assignmentRevision: z.number().int().positive(),
  enabled: z.boolean(), mode: z.enum(['silent', 'queue']),
  events: z.array(z.enum(['source', 'comments', 'ci', 'review', 'state', 'head'])).min(1).max(6),
}).strict()
export const githubNotificationSchema = z.object({
  id: z.string().uuid(), subscription: githubSubscriptionSchema, fingerprint: id, summary: text, createdAt: timestamp,
  status: z.enum(['pending', 'sending', 'sent', 'unknown', 'dismissed']), error: z.string().optional(),
}).strict()
export const githubStateSchema = z.object({
  version: z.literal(1), repositories: z.array(githubRepositorySchema).max(100),
  resources: z.array(githubSnapshotSchema).max(200), links: z.array(githubLinkSchema).max(2000),
  operations: z.array(githubOperationSchema).max(2000), subscriptions: z.array(githubSubscriptionSchema).max(500),
  notifications: z.array(githubNotificationSchema).max(5000),
  imports: z.array(z.object({ resourceId: id, token: z.string().uuid(), sourceHash: id, title: text,
    definition: workDefinitionSchema, workKey: id.optional() }).strict()).max(200),
  errors: z.record(z.string(), z.string()),
}).strict()
export type GitHubSnapshot = z.infer<typeof githubSnapshotSchema>
export type GitHubRepository = z.infer<typeof githubRepositorySchema>
export type GitHubOperation = z.infer<typeof githubOperationSchema>
export type GitHubOperationInput = z.infer<typeof githubOperationInput>
export type GitHubSubscription = z.infer<typeof githubSubscriptionSchema>
export type GitHubNotification = z.infer<typeof githubNotificationSchema>
export type GitHubState = z.infer<typeof githubStateSchema>
export class GitHubError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409 | 502 | 503 = 400) { super(message) }
}
export function parseGitHubUrl(input: string) {
  let url: URL
  try { url = new URL(input) } catch { throw new GitHubError('Use an https://github.com Issue or PR URL.') }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port || url.username || url.password) throw new GitHubError('Use an https://github.com Issue or PR URL.')
  const match = /^\/([^/]+\/[^/]+)\/(issues|pull)\/([1-9]\d*)\/?$/.exec(url.pathname)
  if (!match) throw new GitHubError('Use an Issue or PR URL, not a repository or comment URL.')
  return { repository: repositoryName.parse(match[1]), kind: match[2] === 'pull' ? 'pr' as const : 'issue' as const,
    number: z.coerce.number().int().positive().safe().parse(match[3]) }
}
