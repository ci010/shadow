import { z } from 'zod'
import { ClassifierPolicySchema } from './input-classifier-contract.ts'

/** Reviewed configuration only; deliberately free of host-runtime imports. */
export const InputProcessorSchema = z.object({
  classifier: ClassifierPolicySchema.optional(),
  includeBots: z.boolean().optional(),
  code: z.string().min(1).max(64_000),
  source: z.string().min(1).max(64_000).optional(),
  snapshot: z.array(z.object({ path: z.string().min(1).max(512), source: z.string().max(64000), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).max(32).optional(),
  codeSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  sourceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  delayMs: z.number().int().min(10).max(60_000),
}).strict()
export type InputProcessorPolicy = z.infer<typeof InputProcessorSchema>
