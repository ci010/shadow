import { z } from 'zod'

const key = z.string().trim().min(1).max(600)
const text = z.string().trim().max(2000)
export const workRelationSchema = z.object({
  kind: z.enum(['supports', 'requires', 'assumption']),
  reason: text.min(1),
}).strict()

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

export const workNotesSchema = z.object({
  basis: z.array(z.object({ key, revision: z.number().int().positive() }).strict()).max(100).default([]),
  kind: z.enum(['goal', 'approach', 'task', 'finding']).default('task'),
  relation: workRelationSchema.optional(),
  summary: text.default(''),
  plan: z.array(text.min(1)).max(12).default([]),
  next: text.default(''),
  artifacts: z.array(workArtifactSchema).max(20).default([]),
  html: z.string().max(48_000).default(''),
  attention: z.object({
    kind: z.enum(['assumption', 'scope', 'dependency', 'decision', 'blocker']),
    summary: text.min(1),
    version: z.number().int().positive(),
    at: z.string().datetime(),
    by: z.string().min(1).max(512),
    reviewed: z.object({
      by: z.string().min(1).max(512), at: z.string().datetime(), conclusion: text.min(1),
    }).strict().optional(),
  }).strict().optional(),
}).strict()
export type WorkNotes = z.infer<typeof workNotesSchema>

export const workNotePatchSchema = workNotesSchema.omit({ attention: true, basis: true }).partial().extend({
  attention: workNotesSchema.shape.attention.unwrap().pick({ kind: true, summary: true }).optional(),
}).strict()

export const workContextNodeSchema = z.object({
  key, revision: z.number().int().positive(),
  assignmentRevision: z.number().int().positive().optional(),
  title: z.string().min(1).max(160),
  objective: z.string().min(1).max(4000),
  kind: workNotesSchema.shape.kind,
  relation: workRelationSchema.optional(),
  origin: z.enum(['human', 'agent_interpretation']),
  userQuote: z.string().max(2000).optional(),
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
