import { z } from 'zod'
/** An exact owner-reviewed, independent service capability. No exec/turn identity. */
export const ClassifierPolicySchema = z.object({
  model: z.string().min(1).max(256), instructions: z.string().min(1).max(4000),
  fields: z.array(z.enum(['content','attachments'])).min(1).max(2),
  maxInputBytes: z.number().int().min(1).max(16000), maxTokens: z.number().int().min(32).max(1024),
  maxRequests: z.number().int().min(1).max(100), maxWindowTokens: z.number().int().min(100).max(1000000),
  windowMs: z.number().int().min(1000).max(86400000), deadlineMs: z.number().int().min(10).max(1500),
  minConfidence: z.number().min(0).max(1),
}).strict()
export type ClassifierPolicy = z.infer<typeof ClassifierPolicySchema>
export const ClassificationSchema = z.object({label:z.enum(['ignore','buffer','semanticwake','unknown']),confidence:z.number().min(0).max(1)}).strict()
export type Classification = z.infer<typeof ClassificationSchema>
