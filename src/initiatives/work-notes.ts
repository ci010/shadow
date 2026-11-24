import { workKeySchema } from './work-key.ts'
import { z } from 'zod'
import { workDefinitionSchema } from './work-definition.ts'

const key = workKeySchema
const text = z.string().trim().max(2000)
export const workArtifactSchema = z.object({
  label: z.string().trim().min(1).max(160),
  href: z.string().trim().min(1).max(2000).refine(value => {
    try {
      const url = new URL(value)
      return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password
    } catch {
      if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u0020]/.test(value)) return false
      const resolved = new URL(value.slice(1), 'https://work.invalid/project/')
      return resolved.origin === 'https://work.invalid' && resolved.pathname.startsWith('/project/')
    }
  }, 'Use an HTTP(S) artifact link or a Project-relative resource URL.'),
}).strict()

export const workKindSchema = z.enum(['goal', 'approach', 'task', 'finding'])
export const workSummarySchema = text
export const workArtifactsSchema = z.array(workArtifactSchema).max(20)
export const workBasisSchema = z.array(z.object({ key, revision: z.number().int().positive() }).strict()).max(100)
export type WorkKind = z.infer<typeof workKindSchema>
export type WorkArtifact = z.infer<typeof workArtifactSchema>
export const workReportFields = {
  kind: workKindSchema.default('task'),
  summary: workSummarySchema.default(''),
  artifacts: workArtifactsSchema.default([]),
}

export const workContextNodeSchema = z.object({
  key, revision: z.number().int().positive(),
  assignmentRevision: z.number().int().positive().optional(),
  title: z.string().min(1).max(160),
  definition: workDefinitionSchema,
  kind: workKindSchema,
  origin: z.enum(['human', 'agent_interpretation']),
  contextNeedsReview: z.literal(true).optional(),
  assessment: text.min(1).optional(),
}).strict()

export const workDecisionContextSchema = z.object({
  originKey: key,
  decisionKey: key,
  path: z.array(workContextNodeSchema).min(1).max(100),
}).strict().superRefine((value, ctx) => {
  if (value.path.at(-1)?.key !== value.originKey
    || !value.path.some(node => node.key === value.decisionKey)
    || new Set(value.path.map(node => node.key)).size !== value.path.length) {
    ctx.addIssue({ code: 'custom', message: 'A decision needs a unique goal path ending at its source, with its decision node on that path.' })
  }
})
export type WorkDecisionContext = z.infer<typeof workDecisionContextSchema>
