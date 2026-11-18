import { z } from 'zod'

const amount = z.number().finite().nonnegative()
const count = z.number().int().nonnegative()
export const projectUsageMetricsSchema = z.object({
  calls: z.number().int().nonnegative(),
  tokens: amount.nullable(),
  unknownTokenCalls: z.number().int().nonnegative(),
  costs: z.array(z.object({ currency: z.enum(['USD', 'CNY', 'AI_CREDITS']), amount })),
  unknownCostCalls: z.number().int().nonnegative(),
  durationMs: amount.nullable(),
  unknownDurationCalls: z.number().int().nonnegative(),
})
const activityPeriodSchema = z.object({
  models: z.array(z.object({ name: z.string(), calls: z.number().int().nonnegative(), usage: projectUsageMetricsSchema.optional() })),
  tools: z.array(z.object({ name: z.string(), calls: z.number().int().nonnegative() })),
})
export const projectUsageActivitySchema = z.object({
  total: activityPeriodSchema, today: activityPeriodSchema,
  past7Days: activityPeriodSchema, month: activityPeriodSchema,
})
export type ProjectUsageActivity = z.infer<typeof projectUsageActivitySchema>
const latency = z.object({ samples: count, p50Ms: amount.nullable(), p95Ms: amount.nullable() })
export const requestQualitySchema = z.object({
  asOf: z.string().datetime(), coverage: z.enum(['complete', 'partial']),
  outcomes: z.array(z.object({ outcome: z.string(), requests: count, observedAttempts: count.nullable(), requestsWithAttempts: count })),
  textObservations: z.array(z.object({ observation: z.string(), requests: count })),
  cache: z.object({ readTokens: amount.nullable(), writeTokens: amount.nullable(), inputTokens: amount.nullable(), outputTokens: amount.nullable(),
    requestsWithReadTokens: count, requestsWithWriteTokens: count, requestsWithInputTokens: count, requestsWithOutputTokens: count }),
  firstText: latency, queue: latency, duration: latency,
})
export type RequestQuality = z.infer<typeof requestQualitySchema>
const recallRow = z.object({ entry: z.string(), reads: count })
export const usageRecallSchema = z.object({
  skills: z.array(recallRow).max(100),
  memory: z.array(recallRow.extend({ source: z.enum(['active', 'automatic']) })).max(100),
  coverage: z.enum(['complete', 'partial']),
})
export const projectUsageSchema = z.object({
  requestQuality: requestQualitySchema.optional(),
  recall: usageRecallSchema.optional(),
  activity: projectUsageActivitySchema.default((): ProjectUsageActivity => ({
    total: { models: [], tools: [] }, today: { models: [], tools: [] },
    past7Days: { models: [], tools: [] }, month: { models: [], tools: [] },
  })),
  projectId: z.string(), asOf: z.string().datetime(), timeZone: z.literal('UTC'),
  total: projectUsageMetricsSchema, today: projectUsageMetricsSchema,
  past7Days: projectUsageMetricsSchema, month: projectUsageMetricsSchema,
  daily: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), usage: projectUsageMetricsSchema })),
  firstText: latency.optional(),
  coverage: z.enum(['complete', 'partial']).optional(),
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
