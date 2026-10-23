import { z } from 'zod'
import { ComputerActionSchema, ComputerTargetSchema, computerActionKinds } from '../execution/computer/contracts.ts'

export const ComputerOwnerSchema = z.object({
  projectId: z.string().min(1).max(200), sessionId: z.string().min(1).max(512),
}).strict()
export type ComputerOwner = z.infer<typeof ComputerOwnerSchema>
export const ComputerApprovalSchema = z.object({
  id: z.string().uuid(), targetId: z.string().uuid(), observationId: z.string().uuid(),
  expiresAt: z.string().datetime(), action: ComputerActionSchema,
  element: z.object({ name: z.string().max(512), role: z.string().max(80) }).strict().nullable(),
  frame: z.object({ width: z.number().int().min(1).max(1600), height: z.number().int().min(1).max(1600) }).strict().optional(),
}).strict()
export type ComputerApproval = z.infer<typeof ComputerApprovalSchema>
export const ComputerReceiptSchema = z.object({
  actionId: z.string().uuid(), kind: z.enum(computerActionKinds),
  outcome: z.enum(['executed', 'denied', 'cancelled', 'failed', 'outcome_unknown']),
  verified: z.boolean(),
  focusRestored: z.boolean().nullable().optional(),
}).strict()
export type ComputerReceipt = z.infer<typeof ComputerReceiptSchema>
export const ComputerStatusSchema = ComputerOwnerSchema.extend({
  available: z.boolean(), busy: z.boolean(),
  grant: z.object({ target: ComputerTargetSchema, expiresAt: z.string().datetime() }).strict().nullable(),
  pending: ComputerApprovalSchema.nullable(),
  executing: z.boolean(),
  lastAction: ComputerReceiptSchema.nullable(),
}).strict()
export type ComputerStatus = z.infer<typeof ComputerStatusSchema>
