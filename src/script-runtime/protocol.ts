import { z } from 'zod'
import { MAX_JSON_BYTES } from './json-boundary.ts'
import { PURE_NODE_MODULES, ScriptImportsSchema } from './module-policy.ts'

export const ModeSchema = z.enum(['live', 'test', 'probe'])
export const PolicySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('restricted'), imports: ScriptImportsSchema, mode: ModeSchema.default('live') }).strict(),
  z.object({ kind: z.literal('host') }).strict(),
])

export function validateImports(imports: readonly string[], mode: z.infer<typeof ModeSchema>): string[] {
  const parsed = ScriptImportsSchema.parse(imports)
  if (new Set(parsed).size !== parsed.length) throw new Error('Duplicate script imports.')
  if (mode !== 'live' && parsed.some(name => name.startsWith('node:')
    && !PURE_NODE_MODULES.some(pure => pure === name))) {
    throw new Error('Script test/probe mode refuses effectsful native imports.')
  }
  return parsed
}

export const SafeCallCodeSchema = z.enum([
  'aborted', 'timeout', 'invalid_input', 'invalid_schema', 'invalid_path', 'unsafe_target',
  'route_denied', 'network_error', 'redirect_denied', 'response_too_large', 'http_status',
  'uncertain_outcome', 'capability_denied', 'mock_missing',
  'invalid_body', 'invalid_grant', 'invalid_target', 'idempotency_conflict', 'delivery_retryable',
  'secret_unavailable', 'unknown_secret', 'invalid_secret', 'store_busy', 'store_error', 'store_full', 'corrupt_store',
  'capability_failed',
])
export const CallFailureSchema = z.object({
  code: SafeCallCodeSchema,
  status: z.number().int().min(100).max(599).optional(),
  message: z.string().max(4096).optional(),
}).strict()
export type CallFailure = z.infer<typeof CallFailureSchema>

export function callFailureMessage(failure: CallFailure): string {
  return `Script module call failed: ${failure.code}${failure.status === undefined ? '' : ` HTTP ${failure.status}`}.`
}

const text = z.string().max(MAX_JSON_BYTES)
const id = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER)
export const ToolNameSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,255}$/)
export const ParentPacketSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('start'),
    code: text,
    args: text,
    policy: PolicySchema,
    entry: z.enum(['run', 'script']),
    filename: z.string().max(4096),
    toolNames: z.array(ToolNameSchema).max(1024),
    inferEnabled: z.boolean().default(false),
    maxCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    envKeys: z.array(z.string()),
  }).strict(),
  z.object({ type: z.literal('response'), id, json: text }).strict(),
  z.object({ type: z.literal('rejection'), id, failure: CallFailureSchema }).strict(),
])
export type ParentPacket = z.infer<typeof ParentPacketSchema>

export const ChildPacketSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('result'), json: text }).strict(),
  z.object({ type: z.literal('call'), id, name: ToolNameSchema, json: text }).strict(),
  z.object({ type: z.literal('infer'), id, json: text }).strict(),
  z.object({
    type: z.literal('error'),
    code: z.enum(['import_denied', 'invalid_json', 'guest_failed', 'invalid_entry', 'protocol_error', 'capability_limit', 'capability_failed']),
    failure: CallFailureSchema.optional(),
    message: z.string().max(4096).optional(),
    diagnostic: z.string().max(4096).optional(),
  }).strict(),
])
export type ChildPacket = z.infer<typeof ChildPacketSchema>
