import { z } from 'zod'
import { presentationCardSchema, presentationSourceSchema, validatePresentation } from './presentation-contract.ts'

/** Inferred presentation only: never new work, user intent, ownership or causal edges.
 * groupIndexes uniquely assigns the evidence-owning topic groups to display nodes.
 * IDs are concise stable semantic identifiers, not array positions or worker IDs.
 */
export const projectFocusHierarchyNodeSchema = z.object({
  id: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(160),
  purpose: z.string().trim().min(1).max(500),
  parentId: z.string().trim().min(1).max(120).optional(),
  groupIndexes: z.array(z.number().int().min(0).max(199)).max(200),
}).strict()

export const projectFocusGroupSchema = z.object({
    id: z.string().trim().min(1).max(120).optional(),
    category: z.string().trim().min(1).max(120),
    purpose: z.string().trim().min(1).max(500),
    motivation: z.string().trim().min(1).max(1000),
    topicKeys: z.array(z.string().min(1).max(600)).min(1).max(30),
    cards: z.array(presentationCardSchema).max(20).optional(),
}).strict()

export const projectFocusResultSchema = z.object({
  hierarchy: z.array(projectFocusHierarchyNodeSchema).max(400).optional(),
  groups: z.array(projectFocusGroupSchema).max(200),
}).strict().superRefine((value, ctx) => {
  const keys = value.groups.flatMap(group => group.topicKeys)
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: 'custom', message: 'Each topic may belong to only one focus group.' })
  if (value.hierarchy !== undefined) {
    const nodes = new Map(value.hierarchy.map(node => [node.id, node]))
    const issue = (message: string) => ctx.addIssue({ code: 'custom', message })
    if (nodes.size !== value.hierarchy.length) issue('Hierarchy IDs must be unique.')
    const assigned = value.hierarchy.flatMap(node => node.groupIndexes)
    if (new Set(assigned).size !== assigned.length || assigned.length !== value.groups.length || assigned.some(index => index >= value.groups.length)) {
      issue('Hierarchy must assign every evidence-owning topic group exactly once.')
    }
    for (const node of value.hierarchy) {
      if (!node.groupIndexes.length && !value.hierarchy.some(child => child.parentId === node.id)) issue('Hierarchy nodes must contain topics or subgroups.')
      const seen = new Set<string>()
      let current: typeof node | undefined = node, depth = 0
      while (current) {
        if (seen.has(current.id)) { issue('Hierarchy must be acyclic.'); break }
        seen.add(current.id)
        if (++depth > 4) { issue('Hierarchy depth must not exceed four aggregation levels.'); break }
        if (!current.parentId) break
        const parent = nodes.get(current.parentId)
        if (!parent) { issue('Hierarchy parent must reference an existing node.'); break }
        current = parent
      }
    }
  }
})
export const projectFocusSnapshotSchema = z.object({
  inferredAt: z.string().datetime(),
  origin: z.literal('model_interpretation'),
  revision: z.number().int().nonnegative().optional(),
  organization: z.object({ mode: z.enum(["full", "delta"]), status: z.enum(["running", "completed", "partial"]), coveredCount: z.number().int().nonnegative(), manifestCount: z.number().int().nonnegative(), patches: z.number().int().nonnegative() }).strict().optional(),
  inputCount: z.number().int().min(1).max(200),
  omittedCount: z.number().int().nonnegative(),
  sources: z.array(z.object({ key: z.string().min(1).max(600), sequence: z.number().int().positive() }).strict()).min(1).max(200),
  result: projectFocusResultSchema,
  evidence: z.array(presentationSourceSchema).max(2400).optional(),
  historyPartial: z.boolean().optional(),
  presentationVersion: z.literal(1).optional(),
}).strict().superRefine((value, ctx) => {
  try { validatePresentation(value.result.groups, value.evidence ?? []) }
  catch (error) { ctx.addIssue({ code: 'custom', message: String(error) }) }
  if (value.inputCount !== value.sources.length || new Set(value.sources.map(source => source.key)).size !== value.sources.length) {
    ctx.addIssue({ code: 'custom', message: 'Input count and unique source notes must agree.' })
  }
  if (value.result.hierarchy && value.result.groups.flatMap(group => group.topicKeys).length !== value.sources.length) {
    ctx.addIssue({ code: 'custom', message: 'Hierarchical presentation must retain every supplied topic exactly once.' })
  }
  if (value.result.groups.some(group => group.topicKeys.some(key => !value.sources.some(source => source.key === key)))) {
    ctx.addIssue({ code: 'custom', message: 'Focus groups must cite supplied topic keys.' })
  }
})
export type ProjectFocusSnapshot = z.infer<typeof projectFocusSnapshotSchema>
