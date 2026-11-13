import type { FolderRecord } from './contracts.ts'

/** Fail-closed evidence contract for a future atomic backend recycle operation.
 * This assessment is NOT a deletion capability, nor a reusable authorization token.
 * Evidence must be gathered again under admission exclusion at the mutation boundary.
 */
export interface RecycleEvidence {
  identityVerified: boolean
  cleanIncludingUntrackedAndIgnored: boolean
  noActiveSessionsOrCommands: boolean
  noUnknownOperations: boolean
  currentTip?: string
  integratedTip?: string
  integration?: 'git-ancestry' | 'squash' | 'rebase'
}
export function assessWorkspaceRecycle(folder: FolderRecord, evidence: RecycleEvidence): { eligible: boolean; reasons: string[] } {
  const reasons: string[] = []
  if (folder.lineage?.ownership !== 'shadow-derived') reasons.push('Ownership is unknown or not Shadow-derived')
  if (folder.kind === 'layerfs' || folder.lineage?.backend === 'layerfs') reasons.push('LayerFS integration/deletion evidence is unsupported; retain branches and journals')
  if (folder.lineage?.backend !== 'git-worktree') reasons.push('Verified Git worktree lineage required')
  if (!evidence.identityVerified) reasons.push('Resource identity not verified')
  if (!evidence.cleanIncludingUntrackedAndIgnored) reasons.push('Remaining or unknown filesystem changes')
  if (!evidence.noActiveSessionsOrCommands) reasons.push('Active or unknown resource usage')
  if (!evidence.noUnknownOperations) reasons.push('Unresolved operations')
  if (evidence.integration !== 'git-ancestry' || !evidence.currentTip || !/^[0-9a-f]{40,64}$/.test(evidence.currentTip) || evidence.currentTip !== evidence.integratedTip) reasons.push('Latest tip lacks safe Git ancestry evidence; stale/squash/rebase integration is insufficient')
  return { eligible: reasons.length === 0, reasons }
}
