import { z } from 'zod'

export const pendingWikiPath = z.string().regex(/^(?:topics|concepts|identities|tools)\/[a-z0-9]+(?:-[a-z0-9]+)*\.md$/)
const note = z.string().trim().min(1).max(1200)
export const pendingEvidence = z.object({ sessionId: z.string().min(1).max(256), physicalId: z.string().min(1).max(256),
  offset: z.number().int().nonnegative(), end: z.number().int().positive() }).strict().refine(e => e.end > e.offset)
// Recovery notes, never executable drafts or authority. At most four small candidates.
export const pendingCandidate = z.object({ path: pendingWikiPath, correction: note, action: note, conditions: note,
  evidence: z.array(pendingEvidence).min(1).max(4) }).strict()
export const pendingCandidates = z.array(pendingCandidate).max(4).refine(items => new Set(items.map(i => i.path)).size === items.length,
  'Use one consolidated candidate per Wiki path')
export const candidateResolutions = z.array(z.object({ path: pendingWikiPath,
  outcome: z.enum(['published', 'duplicate', 'superseded', 'unsupported']), reason: note }).strict()).max(4)
