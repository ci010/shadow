import { z } from 'zod'
import { workProgressSchema } from '../initiatives/work-contract.ts'
import { githubSnapshotSchema } from './github/contracts.ts'
import { workNotesSchema, workDecisionContextSchema } from '../initiatives/work-notes.ts'

const id = z.string().min(1)
export const githubWorkReferenceSchema = githubSnapshotSchema.pick({
  url: true, repository: true, number: true, kind: true, state: true, ci: true, review: true, fetchedAt: true,
})
export const projectWorkItemSchema = z.object({
  key: id, title: id, revision: z.number().int().positive(), sequence: z.number().int().positive(),
  status: workProgressSchema.nullable(), parentKey: id.nullable(), dependencies: z.array(id),
  blockedReason: id.nullable(),
  manager: id.nullable(), assignee: id.nullable(), paused: z.boolean(), adopted: z.boolean(),
  proposals: z.number().int().nonnegative(), interpretationReview: z.boolean(), changedAt: id,
  objective: z.string().optional(),
  origin: z.enum(['human', 'agent_interpretation']).optional(),
  userQuote: z.string().optional(),
  notes: workNotesSchema.optional(),
  contextChanged: z.boolean().optional(),
  github: z.array(githubWorkReferenceSchema).optional(),
  observation: z.object({ sessionId: id, observedAt: z.string(), sources: z.array(z.object({ id, physicalId: id })) }).optional(),
})
export const projectWorkOverviewSchema = z.object({
  items: z.array(projectWorkItemSchema),
  sessions: z.array(z.object({
    sessionId: id, title: id, assignable: z.boolean(),
    parentSessionId: id.nullable().optional(), lastActivityAt: id.optional(),
    activity: z.string().optional(),
    workKey: id.optional(),
  })),
  requests: z.array(z.object({
    id, sessionId: id, kind: z.enum(['input', 'decision']), question: id, workKeys: z.array(id),
    recipient: z.enum(['user', 'parent', 'caller']).optional(),
    context: workDecisionContextSchema.optional(),
  })),
  effects: z.array(z.object({
    id, sessionId: id, tool: id, status: z.enum(['running', 'unknown']), workKeys: z.array(id),
  })),
  observer: z.object({
    enabled: z.boolean(), running: z.boolean(), pending: z.number().int().nonnegative(),
    errors: z.array(z.object({ sessionId: id, error: z.string() })), error: z.string().optional(),
  }).optional(),
}).superRefine((value, ctx) => {
  const lookup = new Map(value.items.map(item => [item.key, item]))
  if (lookup.size !== value.items.length) ctx.addIssue({ code: 'custom', path: ['items'], message: 'Duplicate work keys.' })
  const visited = new Set<string>()
  for (const item of value.items) {
    let current: typeof item | undefined = item
    const path = new Set<string>()
    while (current && !visited.has(current.key)) {
      if (path.has(current.key)) {
        ctx.addIssue({ code: 'custom', path: ['items'], message: 'Work hierarchy contains a cycle.' })
        return
      }
      path.add(current.key)
      current = current.parentKey ? lookup.get(current.parentKey) : undefined
    }
    for (const key of path) visited.add(key)
  }
})
export type ProjectWorkItem = z.infer<typeof projectWorkItemSchema>
export type ProjectWorkOverview = z.infer<typeof projectWorkOverviewSchema>
