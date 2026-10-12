import { z } from 'zod'

export const projectFocusResultSchema = z.object({
  groups: z.array(z.object({
    category: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    motivation: z.string().trim().min(1).max(1000),
    topicKeys: z.array(z.string().min(1).max(600)).min(1).max(30),
  }).strict()).max(12),
}).strict().superRefine((value, ctx) => {
  const keys = value.groups.flatMap(group => group.topicKeys)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Each topic may belong to only one focus group.' })
})
export const projectFocusSnapshotSchema = z.object({
  inferredAt: z.string().datetime(),
  origin: z.literal('model_interpretation'),
  inputCount: z.number().int().min(1).max(30),
  omittedCount: z.number().int().nonnegative(),
  sources: z.array(z.object({ key: z.string().min(1).max(600), sequence: z.number().int().positive() }).strict()).min(1).max(30),
  result: projectFocusResultSchema,
}).strict().superRefine((value, ctx) => {
  if (value.inputCount !== value.sources.length || new Set(value.sources.map(source => source.key)).size !== value.sources.length) {
    ctx.addIssue({ code: 'custom', message: 'Input count and unique source notes must agree.' })
  }
  if (value.result.groups.some(group => group.topicKeys.some(key => !value.sources.some(source => source.key === key)))) {
    ctx.addIssue({ code: 'custom', message: 'Focus groups must cite supplied topic keys.' })
  }
})
export type ProjectFocusSnapshot = z.infer<typeof projectFocusSnapshotSchema>
