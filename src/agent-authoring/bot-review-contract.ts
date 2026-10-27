import { z } from 'zod'
import { IntegrationDraftSchema } from '../channels/integration-contract.ts'
import { parsePublicationRequest } from './publication-contract.ts'

export const BotReviewOriginSchema = z.object({ sessionId:z.string().regex(/^web:/).max(512), physicalId:z.string().min(1).max(512), toolCallId:z.string().min(1).max(512) }).strict()
export const BotReviewRecordSchema = z.object({
  version:z.literal(1), projectId:z.string().min(1), id:z.string().min(1),
  origin:BotReviewOriginSchema, createdAt:z.string().datetime(),
  status:z.enum(['pending','waiting','applied','cancelled','expired','stale','error','unavailable']),
  decidedAt:z.string().datetime().optional(),
  currentRevision:z.union([z.number().int().nonnegative(),z.string()]).optional(),
  previousSource:z.record(z.string()).optional(),
  candidate:z.discriminatedUnion('kind',[
    z.object({kind:z.literal('discord'), draft:IntegrationDraftSchema}).strict(),
    z.object({kind:z.literal('service'), request:z.unknown()}).strict(),
  ]),
}).strict().superRefine((record, ctx) => {
  const candidate = record.candidate
  if (candidate.kind === 'discord') {
    if (candidate.draft.id !== record.id || JSON.stringify(candidate.draft.origin) !== JSON.stringify(record.origin)) ctx.addIssue({code:'custom',message:'Review origin mismatch'})
  } else {
    try {
      const request = parsePublicationRequest(candidate.request, record.projectId)
      if (request.id !== record.id || request.sessionId !== record.origin.sessionId || JSON.stringify(request.botReviewOrigin) !== JSON.stringify(record.origin)) throw new Error('Review origin mismatch')
    } catch { ctx.addIssue({code:'custom',message:'Invalid service review'}) }
  }
})
export type BotReviewRecord = z.infer<typeof BotReviewRecordSchema>
