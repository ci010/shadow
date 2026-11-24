import type { WorkRecord } from './work-contract.ts'
import { workNotePath } from './work-note.ts'

/** Durable delivery facts, not requests, approval, or a second Work lifecycle. */
interface RecipientFact {
  id: string
  key: string
  target: string
  deliveryPhysicalIds?: string[]
}
export interface WorkNoteNotification extends RecipientFact {
  kind: 'note_to_manager' | 'note_reply'
  noteId: string
}
interface WorkLifecycleNotification extends RecipientFact {
  kind: 'done' | 'blocked' | 'context' | 'released'
  sequence: number
  assignmentRevision: number
  causeKey?: string
  causeRevision?: number
  causeAssignmentRevision?: number
}
export type WorkNotification = WorkLifecycleNotification | WorkNoteNotification
export const isWorkNoteNotification = (notice: WorkNotification): notice is WorkNoteNotification =>
  notice.kind === 'note_to_manager' || notice.kind === 'note_reply'

export function workNotifications(record: WorkRecord, previous: WorkRecord | undefined, records: WorkRecord[], mutationKind: string): WorkLifecycleNotification[] {
  const result: WorkLifecycleNotification[] = []
  const add = (kind: WorkLifecycleNotification['kind'], target: string | null | undefined, item = record, extra: Partial<WorkLifecycleNotification> = {}) => {
    if (!target || target === record.changedBy) return
    result.push({ id: `${record.key}:${record.sequence}:${kind}:${target}:${item.key}`, key: item.key, target, kind,
      sequence: record.sequence, assignmentRevision: item.assignmentRevision, ...extra })
  }
  const manager = record.manager !== record.assignee ? record.manager : null
  if (record.status === 'done' && previous?.status !== 'done') add('done', manager)
  // The trusted dispatcher mutation already owns publisher-help delivery.
  else if (record.status === 'blocked' && previous?.status !== 'blocked' && mutationKind !== 'automatic_blocked') add('blocked', manager)
  if (previous && (previous.revision !== record.revision || previous.assignee !== record.assignee)) {
    for (const item of previous.revision !== record.revision ? records : []) {
      let ancestor = item
      const seen = new Set<string>()
      while (ancestor.parentKey && !seen.has(ancestor.key)) {
        seen.add(ancestor.key)
        const parent = records.find(candidate => candidate.key === ancestor.parentKey)
        if (!parent) break
        if (parent.key === record.key) {
          if (!['done', 'cancelled'].includes(item.status)) add('context', item.assignee, item, { causeKey: record.key, causeRevision: record.revision, causeAssignmentRevision: record.assignmentRevision })
          break
        }
        ancestor = parent
      }
    }
    if (previous.assignee && previous.assignee !== record.assignee) add('released', previous.assignee)
  }
  return result
}

/** Recheck the latest responsibility and episode, not merely the mutation version. */
export function currentWorkNotification(notice: WorkNotification, records: WorkRecord[]): boolean {
  const record = records.find(item => item.key === notice.key)
  if (!record) return false
  if (isWorkNoteNotification(notice)) return notice.kind === 'note_reply' || record.manager === notice.target
  if (record.assignmentRevision !== notice.assignmentRevision) return false
  if (notice.kind === 'released') return record.assignee !== notice.target && !['done', 'cancelled'].includes(record.status)
  if (notice.kind === 'context') {
    if (record.assignee !== notice.target || ['done', 'cancelled'].includes(record.status)) return false
    const cause = records.find(item => item.key === notice.causeKey)
    if (!cause || cause.revision !== notice.causeRevision || cause.assignmentRevision !== notice.causeAssignmentRevision) return false
    if (record.basis.some(node => node.key === cause.key && node.revision === cause.revision)) return false
    let parent: WorkRecord | undefined = record
    const seen = new Set<string>()
    while (parent?.parentKey && !seen.has(parent.key)) {
      seen.add(parent.key)
      if (parent.parentKey === notice.causeKey) return true
      parent = records.find(item => item.key === parent!.parentKey)
    }
    return false
  }
  if (record.manager !== notice.target || record.assignee === notice.target) return false
  if (notice.kind === 'done') return record.status === 'done' // store expires facts when their status episode ends
  if (notice.kind === 'blocked') return record.status === 'blocked'
  return false
}

export function workNotificationContent(notices: WorkNotification[], records: WorkRecord[]): string {
  const lines = notices.map(notice => {
    if (isWorkNoteNotification(notice)) {
      const reason = notice.kind === 'note_reply' ? 'A Work manager replied to your comment.' : 'A worker requested your attention on a Work comment.'
      return `${reason}\nRead ${workNotePath(notice.key, notice.noteId)}.\n[work-notification:${notice.id}]`
    }
    const record = records.find(item => item.key === notice.key)!
    const reason = notice.kind === 'done' ? `Reported done: ${record.summary}`
      : notice.kind === 'blocked' ? `Blocked: ${record.blockedReason}`
      : notice.kind === 'released' ? 'Assignment changed; do not continue obsolete instructions. Already-running operations are not cancelled.'
      : 'Ancestor context changed; reconsider affected plans.'
    return `${reason}\nRead v:works/keys/${encodeURIComponent(record.key)} (latest version ${record.sequence}).\n[work-notification:${notice.id}]`
  })
  return `Work coordination updates (not authorization or human acceptance):\n${lines.join('\n\n')}\nRead latest Work before acting. No acknowledgement or duplicate status message is required. Comments and review do not clear blocked or grant permission.`
}
