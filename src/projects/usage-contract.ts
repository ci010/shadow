import { z } from 'zod'

const amount = z.number().finite().nonnegative()
export const projectUsageMetricsSchema = z.object({
  calls: z.number().int().nonnegative(),
  tokens: amount.nullable(),
  unknownTokenCalls: z.number().int().nonnegative(),
  costs: z.array(z.object({ currency: z.enum(['USD', 'CNY', 'AI_CREDITS']), amount })),
  unknownCostCalls: z.number().int().nonnegative(),
  durationMs: amount.nullable(),
  unknownDurationCalls: z.number().int().nonnegative(),
})
export const projectUsageSchema = z.object({
  projectId: z.string(), asOf: z.string().datetime(), timeZone: z.literal('UTC'),
  total: projectUsageMetricsSchema, today: projectUsageMetricsSchema,
  past7Days: projectUsageMetricsSchema, month: projectUsageMetricsSchema,
  daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), usage: projectUsageMetricsSchema })),
  scanLimitReached: z.boolean(), untrackedSessions: z.number().int().nonnegative(),
  undatedCalls: z.number().int().nonnegative(),
})
export type ProjectUsageMetrics = z.infer<typeof projectUsageMetricsSchema>
export type ProjectUsage = z.infer<typeof projectUsageSchema>

// Decimal query values only: reject coercions such as empty strings, signs and fractions.
export const projectUsagePageQuerySchema = z.object({
  page: z.string().regex(/^[1-9]\d*$/).default('1').transform(Number).pipe(z.number().int().max(100000)),
})
export const projectUsagePageSchema = z.object({
  projectId: z.string(), asOf: z.string().datetime(),
  page: z.number().int().positive(), pageSize: z.literal(10),
  total: z.number().int().nonnegative(), hasMore: z.boolean(),
  daily: projectUsageSchema.shape.daily.max(10),
})
export type ProjectUsagePage = z.infer<typeof projectUsagePageSchema>
