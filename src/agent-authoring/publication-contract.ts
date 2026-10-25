import { z } from 'zod'
import { ConversationBindingSchema } from './contracts.ts'

const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
const identifier = z.string().min(1).max(200).regex(/^[^\x00-\x20\x7f]+$/)
const resourcePath = z.string().max(160).regex(/^(?:agents\/[a-z][a-z0-9_-]{0,63}\/AGENT\.md|skills\/[a-z][a-z0-9_-]{0,63}\/(?:SKILL\.md|[a-z][a-z0-9_-]{0,63}\.(?:js|ts)))$/)
const source = z.string().max(512_000).nullable()
const binding = ConversationBindingSchema.extend({
  enabled: ConversationBindingSchema.shape.enabled.removeDefault(),
  skills: ConversationBindingSchema.shape.skills.removeDefault(),
  readFolders: ConversationBindingSchema.shape.readFolders.removeDefault(),
  parameters: ConversationBindingSchema.shape.parameters.removeDefault(),
  grants: ConversationBindingSchema.shape.grants.removeDefault(),
})
const requestSchema = z.object({
  id: identifier,
  projectId: identifier,
  sessionId: z.union([z.string().regex(/^web:[^\x00-\x20\x7f]{1,500}$/), z.literal('owner:service-groups')]),
  revision,
  baseRevision: revision,
  createdAt: z.string().datetime().refine(value => {
    const date = new Date(value)
    return Number.isFinite(date.getTime()) && date.toISOString() === value
  }),
  files: z.array(z.object({ path: resourcePath, before: source, after: source }).strict()
    .refine(file => file.before !== file.after, 'Review files must contain changes.')).max(1024),
  previousBindings: z.array(binding).max(1000),
  bindings: z.array(binding).max(1000),
  change: z.object({
    id: identifier, title: z.string().trim().min(1).max(256),
    sourceSessionId: z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/),
    accessRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  }).strict().optional(),
  checks: z.array(z.object({
    id: identifier, kind: identifier, status: z.enum(['passed', 'failed', 'completed']), revision,
  }).strict()).max(4096).refine(checks => new Set(checks.map(check => check.id)).size === checks.length,
    'Duplicate review check IDs.').optional(),
  impact: z.object({
    affectedBindings: z.array(z.string().max(4096)).max(2000),
    permissionsChanged: z.boolean(), toolsChanged: z.boolean(), promptsChanged: z.boolean(),
  }).strict().optional(),
  status: z.enum(['waiting', 'error']).optional(),
  error: z.object({ code: z.literal('publication_failed'), message: z.string().max(500) }).strict().optional(),
}).strict().refine(request => new Set(request.files.map(file => file.path)).size === request.files.length,
  'Duplicate review paths.')
const resultSchema = z.object({
  requestId: identifier,
  revision,
  status: z.enum(['published', 'cancelled', 'waiting']),
}).strict()

export type PublicationRequest = z.infer<typeof requestSchema>
export type PublicationResult = z.infer<typeof resultSchema>

export const PublicationDecisionSchema = z.object({ revision, baseRevision: revision }).strict()

/** Bound JSON before schema traversal, including arbitrary binding parameters. */
function boundedJson(value: unknown): void {
  const seen = new Set<object>()
  let characters = 0
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 200_000 || depth > 64) throw new Error('Publication review exceeds JSON limits.')
    if (item === null || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (typeof item === 'string') {
      characters += item.length
      if (characters > 9 * 1024 * 1024) throw new Error('Publication review exceeds size limit.')
      return
    }
    if (typeof item !== 'object' || item === null || seen.has(item) ||
      (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype &&
        Object.getPrototypeOf(item) !== null)) throw new Error('Expected publication JSON.')
    seen.add(item)
    for (const key of Reflect.ownKeys(item)) {
      if (Array.isArray(item) && key === 'length') continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)!
      if (typeof key !== 'string' || key === '__proto__' || !descriptor.enumerable || !('value' in descriptor)) {
        throw new Error('Expected publication JSON properties.')
      }
      visit(key, depth + 1)
      visit(descriptor.value, depth + 1)
    }
    seen.delete(item)
  }
  visit(value, 0)
}

export function parsePublicationRequest(value: unknown, projectId: string): PublicationRequest {
  identifier.parse(projectId)
  boundedJson(value)
  const request = requestSchema.parse(value)
  if (request.projectId !== projectId) throw new Error('Publication request belongs to another Project.')
  return request
}

export function parsePublicationResult(value: unknown): PublicationResult {
  return resultSchema.parse(value)
}
