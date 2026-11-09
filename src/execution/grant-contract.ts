import { z } from 'zod'

export const ResourceName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
export const JsonSchema = z.record(z.unknown())
const route = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(1024).regex(/^\/[^?#\\]*$/),
  // Host-bound acquisition assertion, never accepted from a capability call.
  effect: z.literal('read').optional(),
  bodySchema: JsonSchema.optional(),
  querySchema: JsonSchema.optional(),
}).strict().refine(value => !value.effect || value.method === 'POST', 'Read acquisition assertions are only supported for POST routes.')

export const CapabilityGrantSchema = z.discriminatedUnion('kind', [
  z.object({
    id: ResourceName, kind: z.literal('http'),
    origin: z.string().url().refine(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
    }, 'HTTP grants require an HTTPS origin without credentials or a path.'),
    routes: z.array(route).min(1).max(32),
    credential: z.object({ secretRef: ResourceName, header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), prefix: z.string().max(64).default('') }).strict().optional(),
  }).strict(),
  z.object({
    id: ResourceName, kind: z.literal('inbox'), sessionId: identifier,
  }).strict(),
])
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>

