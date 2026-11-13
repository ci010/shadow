import { z } from 'zod'
import { CapabilityGrantSchema } from '../../execution/grant-contract.ts'
import { assertSupportedJsonSchema } from '../../execution/grants.ts'
export { canonical, digest } from '../../workflows/json.ts'
export { Drafts } from '../../workflows/contracts.ts'
import { Observation } from '../../workflows/contracts.ts'

export const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
export const SignalRecord = Observation
export type SourceSignal = z.infer<typeof SignalRecord>
export const Collection = z.object({ mode: z.enum(['snapshot', 'delta']).default('snapshot'), signals: z.array(SignalRecord).max(500), checkpoint: z.unknown() }).strict()
export const HttpDeclaration = CapabilityGrantSchema.options[0].omit({ id: true, kind: true, credential: true }).extend({
  credential: z.object({ header: z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), prefix: z.string().max(64).default('') }).strict().optional(),
}).strict()
export const Definition = z.object({
  id: Name, version: z.number().int().positive(), description: z.string().max(2048),
  stateVersion: z.string().min(1).max(64).default('snapshot-v1'),
  // Immutable definition revisions. Extending means publishing another revision/id.
  code: z.string().min(1).max(128000),
  http: HttpDeclaration,
  demandSchema: z.record(z.unknown()).default({}), signalSchema: z.record(z.unknown()).default({}),
  // Consumer prose is authored explicitly, never inferred from implementation descriptions/code.
  consumer: z.object({
    summary: z.string().min(1).max(240),
    unsupported: z.string().min(1).max(160).optional(),
    capabilities: z.array(z.string().min(1).max(400)).max(12),
    limitations: z.array(z.string().min(1).max(400)).max(12),
    semantics: z.array(z.string().min(1).max(400)).max(12),
  }).strict().optional(),
  examples: z.array(z.object({ demand: z.unknown(), signal: SignalRecord }).strict()).max(8).default([]),
}).strict()
export type ProviderDefinition = z.infer<typeof Definition>
export interface SignalSourceProvider {
  readonly definition: ProviderDefinition
  normalize(demand: unknown): unknown
  collect(demands: Array<{ key: string; demand: unknown; checkpoint: unknown }>,
    request: (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>, signal: AbortSignal): Promise<Record<string, z.infer<typeof Collection>>>
}
export function validateDefinition(definition: ProviderDefinition): void {
  assertSupportedJsonSchema(definition.demandSchema)
  assertSupportedJsonSchema(definition.signalSchema)
  definition.http.routes.forEach(route => { if (route.bodySchema) assertSupportedJsonSchema(route.bodySchema); if (route.querySchema) assertSupportedJsonSchema(route.querySchema) })
}
