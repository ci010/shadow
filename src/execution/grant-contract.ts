import { z } from 'zod'

export const ResourceName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x1f\x7f]+$/)
export const JsonSchema = z.record(z.unknown())
const route = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  path: z.string().min(1).max(1024).regex(/^\/[^?#\\]*$/),
  bodySchema: JsonSchema.optional(),
  querySchema: JsonSchema.optional(),
}).strict()

export const CapabilityGrantSchema = z.discriminatedUnion('kind', [
  z.object({
    id: ResourceName, kind: z.literal('http'),
    origin: z.string().url().refine(value => {
      const url = new URL(value)
      return url.protocol === 'https:' && url.origin === value && !url.username && !url.password
    }, 'HTTP grants require an HTTPS origin without credentials or a path.'),
    routes: z.array(route).min(1).max(32),
    // Optional fail-closed read semantics for fixed GraphQL POST queries. No mutation ledger.
    readOnlyGraphqlQueries: z.array(z.string().min(1).max(16000)).min(1).max(8).optional(),
    credential: z.object({ secretRef: ResourceName, header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), prefix: z.string().max(64).default('') }).strict().optional(),
  }).strict(),
  z.object({
    id: ResourceName, kind: z.literal('inbox'), sessionId: identifier,
  }).strict(),
  z.object({
    id: ResourceName, kind: z.literal('proposal-inbox'), inbox: ResourceName,
    disclosurePolicy: z.object({ kind: z.literal('public-github-issue-proposal'), repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/) }).strict(),
  }).strict(),
])
export type CapabilityGrant = z.infer<typeof CapabilityGrantSchema>

