import { z } from 'zod'
import { CapabilityGrantSchema, ResourceName } from './contracts.ts'

const identifier = z.string().min(1).max(512).regex(/^[^\x00-\x20\x7f]+$/)
const revision = z.string().regex(/^sha256:[a-f0-9]{64}$/)
export const ProbeAddressSchema = z.object({
  projectId: identifier, botInstanceId: identifier,
  platform: z.enum(['qq', 'discord', 'feishu']), conversationId: identifier,
}).strict()
export const ProbeGrantSchema = CapabilityGrantSchema.options[0].extend({
  routes: z.array(z.object({
    method: z.literal('GET'), path: z.string().min(1).max(1024).regex(/^\/[^?#\\]*$/),
  }).strict()).min(1).max(32),
})
export const ProbeRequestSchema = z.object({
  id: identifier, projectId: identifier, changeId: identifier,
  title: z.string().min(1).max(200), revision, sourceSessionId: identifier,
  accessRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  createdAt: z.string().datetime(), expiresAt: z.string().datetime(),
  toolName: ResourceName, sourceHash: revision, address: ProbeAddressSchema,
  source: z.object({ path: z.string().min(1).max(512), code: z.string().max(256 * 1024) }).strict().optional(),
  arguments: z.record(z.unknown()), grants: z.array(ProbeGrantSchema).min(1).max(32),
  maxCalls: z.number().int().min(1).max(20),
  status: z.enum(['pending', 'running', 'completed', 'failed', 'cancelled']),
  runId: identifier.optional(), error: z.string().max(1000).optional(),
}).strict()
const resultSchema = z.object({
  requestId: identifier, revision,
  status: z.enum(['completed', 'failed', 'cancelled']),
  runId: identifier.optional(), error: z.string().max(1000).optional(),
}).strict()
export const ProbeDecisionSchema = z.object({ revision }).strict()
export type ProbeRequest = z.infer<typeof ProbeRequestSchema>
export type ProbeDecisionResult = z.infer<typeof resultSchema>

export function parseProbeRequest(value: unknown, projectId: string): ProbeRequest {
  const request = ProbeRequestSchema.parse(value)
  if (request.projectId !== projectId || request.address.projectId !== projectId) {
    throw new Error('Probe request belongs to another Project.')
  }
  if (Date.parse(request.expiresAt) <= Date.parse(request.createdAt)) throw new Error('Invalid probe expiration.')
  return request
}

export function parseProbeDecisionResult(value: unknown): ProbeDecisionResult {
  return resultSchema.parse(value)
}
