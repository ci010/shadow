/** Renderer-safe identities only. References convey context, never execution authority. */
export const workflowNodeKinds = ['transform', 'inbox', 'record', 'work-map', 'schedule-action', 'github-notify', 'host-action'] as const
export type WorkflowNodeKind = typeof workflowNodeKinds[number]
export type WorkflowReferenceSelector = { kind: 'source' } | { kind: 'gate' } | { kind: 'node'; index: number; nodeKind: WorkflowNodeKind }
export type InputReference = WorkflowInputReference | ConnectionSinkInputReference
export interface ConnectionSinkInputReference { kind: 'connection-sink'; projectId: string; connectionId: string; receiverId?: string }
export interface WorkflowInputReference {
  kind: 'workflow'
  projectId: string
  workflowId: string
  revision: number
  runId?: string
  selector?: WorkflowReferenceSelector
}
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const keys = (v: Record<string, unknown>, allowed: string[]) => Object.keys(v).every(k => allowed.includes(k))
const id = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 256 && !/[\x00-\x1f\x7f]/.test(v)
export function parseInputReferences(value: unknown): InputReference[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8) throw new TypeError('invalid_references')
  return value.map((v): InputReference => {
    if (object(v) && v.kind === 'connection-sink') {
      if (!keys(v, ['kind', 'projectId', 'connectionId', 'receiverId']) || !id(v.projectId) || (v.receiverId !== undefined && !id(v.receiverId)) || typeof v.connectionId !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(v.connectionId)) throw new TypeError('invalid_references')
      return { kind: 'connection-sink', projectId: v.projectId, connectionId: v.connectionId,
        ...(v.receiverId !== undefined ? { receiverId: v.receiverId as string } : {}) }
    }
    if (!object(v) || !keys(v, ['kind', 'projectId', 'workflowId', 'revision', 'runId', 'selector']) || v.kind !== 'workflow' ||
      !id(v.projectId) || !id(v.workflowId) || !Number.isSafeInteger(v.revision) || (v.revision as number) < 1 ||
      (v.runId !== undefined && !id(v.runId))) throw new TypeError('invalid_references')
    const s = v.selector
    if (s !== undefined && (!object(s) || !(s.kind === 'source' || s.kind === 'gate'
      ? keys(s, ['kind'])
      : s.kind === 'node' && keys(s, ['kind', 'index', 'nodeKind']) && Number.isSafeInteger(s.index) &&
        (s.index as number) >= 0 && (s.index as number) < 8 && workflowNodeKinds.includes(s.nodeKind as WorkflowNodeKind)))) throw new TypeError('invalid_reference_selector')
    // Copy rather than retaining a caller-owned mutable object.
    return { kind: 'workflow', projectId: v.projectId, workflowId: v.workflowId, revision: v.revision as number,
      ...(v.runId !== undefined ? { runId: v.runId as string } : {}), ...(s !== undefined ? { selector: { ...s as WorkflowReferenceSelector } } : {}) }
  })
}
