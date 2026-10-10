import { z } from 'zod'

export const workBindingSchema = z.object({
  key: z.string().trim().min(1).max(600),
}).strict()

const policySchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('optional') }).strict(),
  z.object({
    mode: z.literal('required'),
    controllerSessionId: z.string().trim().min(1).max(512),
    keys: z.array(z.string().trim().min(1).max(600)).min(1).max(100)
      .refine(keys => new Set(keys).size === keys.length, 'Duplicate Work bindings'),
  }).strict(),
])

export type WorkPolicy = z.infer<typeof policySchema>
export type WorkBinding = z.infer<typeof workBindingSchema>
export class WorkPolicyError extends Error {}

export function parseWorkPolicy(value: unknown): WorkPolicy | undefined {
  if (value === undefined) return undefined
  const parsed = policySchema.safeParse(value)
  if (!parsed.success) throw new WorkPolicyError(`Invalid Work policy: ${parsed.error.message}`)
  return parsed.data
}
