import type { WorkRecord } from './work-contract.ts'

/** Durable delivery facts, not requests, approval, or a second Work lifecycle. */
export interface WorkNotification {
  id: string
  key: string
  target: string
  kind: 'done' | 'blocked' | 'attention' | 'return_to_assignee' | 'context' | 'released'
  sequence: number
  assignmentRevision: number
  attentionVersion?: number
  reviewVersion?: number
  reviewContext?: { key: string; revision: number }[]
  deliveryPhysicalIds?: string[]
  causeKey?: string
  causeRevision?: number
  causeAssignmentRevision?: number
}

export function workNotifications(record: WorkRecord, previous: WorkRecord | undefined, records: WorkRecord[]): WorkNotification[] {
  const flow = record.workflow
  if (!flow || !record.notes) return []
  const result: WorkNotification[] = []
  const add = (kind: WorkNotification['kind'], target: string | null | undefined, item = record, extra: Partial<WorkNotification> = {}) => {
    if (!target || target === record.changedBy) return
    result.push({ id: `${record.key}:${record.sequence}:${kind}:${target}:${item.key}`, key: item.key, target, kind,
      sequence: record.sequence, assignmentRevision: item.workflow!.assignmentRevision, ...extra })
  }
  const attention = record.notes.attention
  const newAttention = attention && !attention.reviewed && attention.version !== previous?.notes?.attention?.version
  const hostAutomaticBlock = record.automaticExecution?.stage === 'blocked' && attention?.by === record.automaticExecution.sessionId
  const manager = flow.manager !== flow.assignee && !hostAutomaticBlock ? flow.manager : null
  // One manager fact for blocked + attention in the same mutation.
  if (flow.status === 'done' && previous?.workflow?.status !== 'done') add('done', manager)
  else if (flow.status === 'blocked' && previous?.workflow?.status !== 'blocked') add('blocked', manager, record, { attentionVersion: attention?.version })
  else if (newAttention && flow.status !== 'cancelled' && flow.status !== 'done') add('attention', manager, record, { attentionVersion: attention.version })
  const review = attention?.reviewed
  if (review?.disposition === 'return_to_assignee' && review.version !== previous?.notes?.attention?.reviewed?.version
    && review.assignmentRevision === flow.assignmentRevision && !['done', 'cancelled'].includes(flow.status)) {
    add('return_to_assignee', flow.assignee, record, { attentionVersion: attention!.version, reviewVersion: review.version,
      reviewContext: [...record.notes.basis, { key: record.key, revision: record.revision }] })
  }
  if (previous && (previous.revision !== record.revision || previous.workflow?.assignee !== flow.assignee)) {
    for (const item of previous.revision !== record.revision ? records : []) {
      let ancestor = item
      const seen = new Set<string>()
      while (ancestor.workflow?.parentKey && !seen.has(ancestor.key)) {
        seen.add(ancestor.key)
        const parent = records.find(candidate => candidate.key === ancestor.workflow!.parentKey)
        if (!parent) break
        if (parent.key === record.key) {
          if (item.workflow && !['done', 'cancelled'].includes(item.workflow.status)) add('context', item.workflow.assignee, item, { causeKey: record.key, causeRevision: record.revision, causeAssignmentRevision: flow.assignmentRevision })
          break
        }
        ancestor = parent
      }
    }
    if (previous.workflow?.assignee && previous.workflow.assignee !== flow.assignee) add('released', previous.workflow.assignee)
  }
  return result
}

/** Recheck the latest responsibility and episode, not merely the mutation version. */
export function currentWorkNotification(notice: WorkNotification, records: WorkRecord[]): boolean {
  const record = records.find(item => item.key === notice.key)
  const flow = record?.workflow
  if (!flow || flow.assignmentRevision !== notice.assignmentRevision) return false
  const attention = record.notes?.attention
  if (notice.kind === 'released') return flow.assignee !== notice.target && !['done', 'cancelled'].includes(flow.status)
  if (notice.kind === 'context') {
    if (flow.assignee !== notice.target || ['done', 'cancelled'].includes(flow.status)) return false
    const cause = records.find(item => item.key === notice.causeKey)
    if (!cause || cause.revision !== notice.causeRevision || cause.workflow?.assignmentRevision !== notice.causeAssignmentRevision) return false
    if (record.notes?.basis.some(node => node.key === cause.key && node.revision === cause.revision)) return false
    let parent: WorkRecord | undefined = record
    const seen = new Set<string>()
    while (parent?.workflow?.parentKey && !seen.has(parent.key)) {
      seen.add(parent.key)
      if (parent.workflow.parentKey === notice.causeKey) return true
      parent = records.find(item => item.key === parent!.workflow!.parentKey)
    }
    return false
  }
  if (notice.kind === 'return_to_assignee') return flow.assignee === notice.target && !['done', 'cancelled'].includes(flow.status)
    && !!attention && attention.version === notice.attentionVersion && attention.reviewed?.disposition === 'return_to_assignee'
    && attention.reviewed.assignmentRevision === flow.assignmentRevision && attention.reviewed.version === notice.reviewVersion
    && notice.reviewContext?.every(node => records.some(item => item.key === node.key && item.revision === node.revision)) === true
  if (flow.manager !== notice.target || flow.assignee === notice.target) return false
  if (notice.kind === 'done') return flow.status === 'done' // store expires facts when their status episode ends
  if (notice.kind === 'blocked') return flow.status === 'blocked' && (notice.attentionVersion === undefined || !!attention && attention.version === notice.attentionVersion && !attention.reviewed)
  return !['done', 'cancelled'].includes(flow.status) && !!attention && attention.version === notice.attentionVersion && !attention.reviewed
}

export function workNotificationContent(notices: WorkNotification[], records: WorkRecord[]): string {
  const lines = notices.map(notice => {
    const record = records.find(item => item.key === notice.key)!
    const reason = notice.kind === 'return_to_assignee' ? `Coordinator response: ${record.notes?.attention?.reviewed?.conclusion}`
      : notice.kind === 'done' ? `Reported done: ${record.notes?.summary}`
      : notice.kind === 'blocked' ? `Blocked: ${record.workflow?.blockedReason}`
      : notice.kind === 'attention' ? `Needs coordination${record.notes?.attention?.awaitingResponse ? ' (executor waiting for a response)' : ''}: ${record.notes?.attention?.summary}`
      : notice.kind === 'released' ? 'Assignment changed; do not continue obsolete instructions. Already-running operations are not cancelled.'
      : 'Ancestor context changed; reconsider affected plans.'
    return `${reason}\nRead v:works/keys/${encodeURIComponent(record.key)} (latest version ${record.sequence}).\n[work-notification:${notice.id}]`
  })
  return `Work coordination updates (not authorization or human acceptance):\n${lines.join('\n\n')}\nRead latest Work before acting. No acknowledgement or duplicate status message is required. Review does not clear blocked or grant permission.`
}
