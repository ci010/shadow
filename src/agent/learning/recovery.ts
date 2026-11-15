import { z } from 'zod'

/** Review input only; never inferred from untrusted error text. */
export const correctionRequest = z.object({
  batchId: z.string().uuid(),
  target: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
  correction: z.string().trim().min(1).max(1200),
  evidence: z.array(z.string().trim().startsWith('v:').max(2000)).min(1).max(4),
  changed: z.string().trim().min(1).max(1200),
}).strict()
export type CorrectionRequest = z.infer<typeof correctionRequest>
export const correctionRecovery = correctionRequest.extend({
  originalFailure: z.string().min(1).max(16000),
  admitted: z.boolean(),
  closedReason: z.string().optional(),
  priorArtifactRevision: z.string().optional(),
})
