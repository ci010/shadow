import { z } from 'zod'

/** Display evidence only. Never instructions, acceptance, or execution ownership. */
export const presentationSourceSchema = z.object({
  sessionId: z.string().min(1).max(600), physicalId: z.string().min(1).max(600),
  id: z.string().min(1).max(600), kind: z.enum(['human', 'assistant', 'report']),
  text: z.string().min(1).max(4000), at: z.string().optional(),
}).strict()
export const presentationReferenceSchema = presentationSourceSchema.pick({ sessionId: true, physicalId: true, id: true })
export const presentationCardSchema = z.object({
  id: z.string().trim().min(1).max(120), title: z.string().trim().min(1).max(160),
  state: z.enum(['planned', 'in_progress', 'completed', 'reported_complete', 'deferred', 'abandoned', 'unknown']),
  markdown: z.string().trim().min(1).max(4000),
  sources: z.array(presentationReferenceSchema).min(1).max(12),
  stateSources: z.array(presentationReferenceSchema).min(1).max(12),
}).strict()
export type PresentationSource = z.infer<typeof presentationSourceSchema>
export const sourceIdentity = (source: z.infer<typeof presentationReferenceSchema>) => JSON.stringify([source.sessionId, source.physicalId, source.id])

/** Validate provenance and user involvement, not semantic truth via keyword heuristics. */
export function validatePresentation(groups: { cards?: z.infer<typeof presentationCardSchema>[] }[], evidence: PresentationSource[]) {
  const sources = new Map(evidence.map(source => [sourceIdentity(source), source]))
  const ids = new Set<string>()
  for (const group of groups) for (const card of group.cards ?? []) {
    if (ids.has(card.id)) throw new Error('Duplicate presentation card ID.')
    ids.add(card.id)
    if (![...card.sources, ...card.stateSources].every(ref => sources.has(sourceIdentity(ref)))) throw new Error('Presentation cites unavailable conversation evidence.')
    if (!card.sources.some(ref => sources.get(sourceIdentity(ref))?.kind === 'human')) throw new Error('Presentation cards require human conversation evidence, not delegate-only work.')
    if (['abandoned', 'deferred'].includes(card.state) && !card.stateSources.some(ref => sources.get(sourceIdentity(ref))?.kind === 'human')) throw new Error('Discarded or deferred states require explicit human evidence.')
    if (!card.stateSources.every(ref => card.sources.some(source => sourceIdentity(source) === sourceIdentity(ref)))) throw new Error('State evidence must be part of the card evidence.')
  }
}
