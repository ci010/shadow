import { z } from 'zod'

export const MemoryDomainKind = z.enum(['project-private', 'conversation', 'shared', 'agent-private'])
export const MemoryDomainRefSchema = z.object({
  id: z.string().uuid(), revision: z.number().int().positive(),
}).strict()
export type MemoryDomainRef = z.infer<typeof MemoryDomainRefSchema>
export const MemorySourceSchema = z.object({
  domain: MemoryDomainRefSchema,
  resourceId: z.string().uuid().optional(),
  version: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sessionId: z.string().min(1).max(1024).optional(),
  epoch: z.string().uuid().optional(),
}).strict().refine(source => !!source.resourceId === !!source.version && !!source.sessionId === !!source.epoch,
  'Memory source identities require their corresponding immutable version or epoch.')
export type MemorySource = z.infer<typeof MemorySourceSchema>
export const MemoryDomainSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(160),
  kind: MemoryDomainKind, revision: z.number().int().positive(),
  revoked: z.boolean(), createdAt: z.string().datetime(),
  managementBindingId: z.string().uuid().optional(),
  owner: z.object({ sessionId: z.string().min(1).max(1024), epoch: z.string().uuid() }).strict().optional(),
}).strict()
export type MemoryDomain = z.infer<typeof MemoryDomainSchema>
export const MemoryResourceSchema = z.object({
  id: z.string().uuid(), domainId: z.string().uuid(),
  kind: z.enum(['note', 'skill', 'summary', 'decision', 'event', 'history', 'soul-draft']).default('note'),
  title: z.string().trim().min(1).max(200), version: z.string().regex(/^[a-f0-9]{64}$/),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().datetime(), current: z.boolean(), revoked: z.boolean(),
  sources: z.array(MemorySourceSchema).max(4096),
  publication: z.object({
    id: z.string().uuid(), actor: z.string().min(1).max(1024), at: z.string().datetime(),
  }).strict().optional(),
}).strict()
export type MemoryResource = z.infer<typeof MemoryResourceSchema>
export const DerivedMemoryInputSchema = z.object({
  id: z.string().uuid(), title: MemoryResourceSchema.shape.title,
  kind: MemoryResourceSchema.shape.kind, content: z.string().min(1).max(256_000),
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict()
export type DerivedMemoryInput = z.infer<typeof DerivedMemoryInputSchema>

export class MemoryAccessError extends Error {
  readonly code = 'memory_access_denied'
  constructor() { super('Memory is unavailable in this execution scope.'); this.name = 'MemoryAccessError' }
}

export interface MemoryAccess {
  readonly projectId: string
  readonly sessionId: string
  readonly epoch: string
}

export interface MemoryAccessOptions {
  sessionId: string
  epoch: string
  read: readonly MemoryDomainRef[]
  write?: MemoryDomainRef
  sources?: readonly MemorySource[]
  assertCurrent: () => void
  onSources?: (sources: MemorySource[]) => void
}
