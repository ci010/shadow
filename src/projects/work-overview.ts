import { workKeySchema } from '../initiatives/work-key.ts'
import { z } from 'zod'
import { projectFocusSnapshotSchema, projectFocusOverviewSchema } from './focus-contract.ts'
import { workFocusInferenceSchema, workProgressSchema, workDefinitionSchema } from '../initiatives/work-contract.ts'
import { githubSnapshotSchema } from './github/contracts.ts'
import { workReportFields, workBasisSchema, workDecisionContextSchema } from '../initiatives/work-notes.ts'

const id = z.string().min(1)
export const githubWorkReferenceSchema = githubSnapshotSchema.pick({
  url: true, repository: true, number: true, kind: true, state: true, ci: true, review: true, fetchedAt: true,
})
export const projectWorkItemSchema = z.object({
  key: workKeySchema, title: id, revision: z.number().int().positive(), sequence: z.number().int().positive(),
  status: workProgressSchema.nullable(), parentKey: workKeySchema.nullable(), dependencies: z.array(workKeySchema),
  blockedReason: id.nullable(),
  manager: id.nullable(), assignee: id.nullable(),
  changedAt: id,
  definition: workDefinitionSchema.optional(),
  origin: z.enum(['human', 'agent_interpretation']).optional(),
  ...workReportFields,
  basis: workBasisSchema.default([]), contextAssessment: z.string().trim().min(1).max(2000).optional(),
  contextChanged: z.boolean().optional(),
  github: z.array(githubWorkReferenceSchema).optional(),
  observation: z.object({ sessionId: id, observedAt: z.string(), sources: z.array(z.object({ id, physicalId: id })), focus: workFocusInferenceSchema.optional() }).optional(),
}).strict()
const projectWorkOverviewBaseSchema = z.object({
  focus: projectFocusSnapshotSchema.optional(),
  items: z.array(projectWorkItemSchema),
  sessions: z.array(z.object({
    sessionId: id, title: id, assignable: z.boolean(),
    parentSessionId: id.nullable().optional(), lastActivityAt: id.optional(),
    activity: z.string().optional(),
    workKey: workKeySchema.optional(),
    workKeys: z.array(workKeySchema).optional(),
    topic: z.string().optional(), focus: z.string().optional(),
    description: z.string().optional(), completed: z.boolean().optional(),
    topicSequence: z.number().int().positive().optional(),
  })),
  requests: z.array(z.object({
    id, sessionId: id, kind: z.enum(['input', 'decision']), question: id, workKeys: z.array(workKeySchema),
    recipient: z.enum(['user', 'parent', 'caller']).optional(),
    context: workDecisionContextSchema.optional(),
  })),
  effects: z.array(z.object({
    id, sessionId: id, tool: id, status: z.enum(['running', 'unknown']), workKeys: z.array(workKeySchema),
  })),
  organization: z.object({
    organization: z.object({phase:z.enum(['evidence','hierarchy']).optional(),mode:z.enum(['full','delta']),status:z.enum(['running','completed','partial']),coveredCount:z.number().int().nonnegative(),manifestCount:z.number().int().nonnegative(),patches:z.number().int().nonnegative()}).optional(),
    enabled: z.boolean(), running: z.boolean(),
    lastAutomaticError: z.enum(['organization_delta_check_failed', 'organization_execution_failed']).optional(),
    lastCheckedAt: z.string().datetime().optional(),
    nextAutomaticAt: z.string().datetime().optional(),
  }).optional(),
})
const validateOverview = (value: Pick<z.infer<typeof projectWorkOverviewBaseSchema>, 'items'>, ctx: z.RefinementCtx) => {
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
}
export const projectWorkOverviewSchema = projectWorkOverviewBaseSchema.superRefine(validateOverview)
export const projectWorkLiveOverviewSchema = projectWorkOverviewBaseSchema.extend({ focus: projectFocusOverviewSchema.optional() }).superRefine(validateOverview)
export type ProjectWorkItem = z.infer<typeof projectWorkItemSchema>
export type ProjectWorkOverview = z.infer<typeof projectWorkLiveOverviewSchema>

/** Read-time projection only: a previously organized standalone conversation must not
 * remain a duplicate root after an explicit Work association. Saved evidence stays intact. */
export function visibleProjectFocus(data: ProjectWorkOverview): ProjectWorkOverview['focus'] {
  const focus = data.focus
  if (!focus) return undefined
  const obsolete = new Set(data.sessions.filter(session => !session.assignable || data.items.some(item =>
    item.key === session.workKey || session.workKeys?.includes(item.key) || item.assignee === session.sessionId || item.observation?.sessionId === session.sessionId))
    .map(session => `session:${session.sessionId}`))
  if (!focus.result.groups.some(group => group.topicKeys.some(key => obsolete.has(key)))) return focus
  const indexes = new Map<number, number>()
  const groups = focus.result.groups.flatMap((group, index) => {
    const topicKeys = group.topicKeys.filter(key => !obsolete.has(key))
    if (!topicKeys.length) return []
    indexes.set(index, indexes.size)
    const removedIds = new Set(group.topicKeys.filter(key => obsolete.has(key)).map(key => key.slice(8)))
    return [{ ...group, topicKeys, cards: group.cards?.filter(card => card.sources.some(source => !removedIds.has(source.sessionId))) }]
  })
  if (!groups.length) return undefined
  const hierarchy = focus.result.hierarchy?.map(node => ({ ...node, groupIndexes: node.groupIndexes.flatMap(index => indexes.has(index) ? [indexes.get(index)!] : []) }))
  if (hierarchy) {
    let changed = true
    while (changed) {
      changed = false
      for (let i = hierarchy.length - 1; i >= 0; i--) if (!hierarchy[i]!.groupIndexes.length && !hierarchy.some(node => node.parentId === hierarchy[i]!.id)) { hierarchy.splice(i, 1); changed = true }
    }
  }
  const sources = focus.sources.filter(source => !obsolete.has(source.key))
  return { ...focus, inputCount: sources.length, sources, result: { groups, hierarchy } }
}
