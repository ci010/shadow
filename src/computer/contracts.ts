import { z } from 'zod'
import { ComputerTargetSchema, computerActionKinds } from '../execution/computer/contracts.ts'

export const ComputerOwnerSchema = z.object({
  projectId: z.string().min(1).max(200), sessionId: z.string().min(1).max(512),
}).strict()
export type ComputerOwner = z.infer<typeof ComputerOwnerSchema>
export const ComputerReceiptSchema = z.object({
  actionId: z.string().uuid(), kind: z.enum(computerActionKinds),
  outcome: z.enum(['executed', 'cancelled', 'failed', 'outcome_unknown']),
  verified: z.boolean(),
  focusRestored: z.boolean().nullable().optional(),
}).strict()
export type ComputerReceipt = z.infer<typeof ComputerReceiptSchema>
export const ComputerStatusSchema = ComputerOwnerSchema.extend({
  available: z.boolean(), busy: z.boolean(),
  grant: z.object({ target: ComputerTargetSchema, expiresAt: z.string().datetime() }).strict().nullable(),
  executing: z.boolean(),
  lastAction: ComputerReceiptSchema.nullable(),
}).strict()
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>
