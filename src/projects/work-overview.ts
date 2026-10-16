import { z } from 'zod'
import { projectFocusSnapshotSchema } from './focus-contract.ts'
import { workFocusInferenceSchema, workProgressSchema } from '../initiatives/work-contract.ts'
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
  decisionInfluences: z.array(z.object({ reason: z.string(), baseRevision: z.number().int().positive(), appliedRevision: z.number().int().positive(), request: z.object({ sessionId: id, physicalId: id, requestId: id }) })).optional(),
  origin: z.enum(['human', 'agent_interpretation']).optional(),
  userQuote: z.string().optional(),
  notes: workNotesSchema.optional(),
  contextChanged: z.boolean().optional(),
  github: z.array(githubWorkReferenceSchema).optional(),
  observation: z.object({ sessionId: id, observedAt: z.string(), sources: z.array(z.object({ id, physicalId: id })), focus: workFocusInferenceSchema.optional() }).optional(),
})
export const projectWorkOverviewSchema = z.object({
  focus: projectFocusSnapshotSchema.optional(),
  items: z.array(projectWorkItemSchema),
  sessions: z.array(z.object({
    sessionId: id, title: id, assignable: z.boolean(),
    parentSessionId: id.nullable().optional(), lastActivityAt: id.optional(),
    activity: z.string().optional(),
    workKey: id.optional(),
    workKeys: z.array(id).optional(),
    description: z.string().optional(), completed: z.boolean().optional(),
    topicSequence: z.number().int().positive().optional(),
  })),
  requests: z.array(z.object({
    id, sessionId: id, kind: z.enum(['input', 'decision']), question: id, workKeys: z.array(id),
    recipient: z.enum(['user', 'parent', 'caller']).optional(),
    context: workDecisionContextSchema.optional(),
  })),
  effects: z.array(z.object({
    id, sessionId: id, tool: id, status: z.enum(['running', 'unknown']), workKeys: z.array(id),
  })),
  organization: z.object({
    organization: z.object({mode:z.enum(['full','delta']),status:z.enum(['running','completed','partial']),coveredCount:z.number().int().nonnegative(),manifestCount:z.number().int().nonnegative(),patches:z.number().int().nonnegative()}).optional(),
    enabled: z.boolean(), running: z.boolean(),
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
