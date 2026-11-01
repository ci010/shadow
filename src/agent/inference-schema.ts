import { z } from 'zod'
import { REASONING_EFFORTS } from './llm-config.ts'

/** Data-only inference overrides. Omitted fields inherit runtime defaults. */
export const agentInferenceSchema = z.object({
  model: z.string().min(1).optional(), temperature: z.number().finite().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  thinking: z.object({ type: z.enum(['enabled', 'disabled']) }).strict().optional(),
  reasoningEffort: z.enum(REASONING_EFFORTS).optional(),
}).strict()
