import { z } from 'zod'

export const RETIREMENT_INACTIVITY_DAYS = 5

export const retirementReceiptSchema = z.object({
  retiredAt: z.string().datetime(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  assessorSessionId: z.string().min(1),
  reason: z.string().min(1),
}).strict()

export const retirementProposalSchema = z.object({
  outcome: z.enum(['complete', 'continued', 'blocked']),
  reason: z.string().min(1).max(4000),
  continuationSessionId: z.string().optional(),
  knowledge: z.enum(['none', 'already-preserved', 'preserve', 'unresolved']),
  /** Existing durable knowledge files; the host verifies they are outside session storage. */
  knowledgeFiles: z.array(z.string()).max(30),
  knowledgeEntries: z.array(z.object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}\.md$/),
    content: z.string().min(1).max(16000),
  }).strict()).max(10).default([]),
  files: z.array(z.object({
    source: z.string(),
    destination: z.string(),
  }).strict()).max(100),
}).strict()

export type RetirementReceipt = z.infer<typeof retirementReceiptSchema>
