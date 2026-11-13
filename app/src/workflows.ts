import { t, type MessageKey } from './i18n.ts'
import { isRecord } from './folders-sidebar.ts'
import { projectJson } from './projects.ts'

export type WorkflowStatus = 'queued' | 'running' | 'retry' | 'blocked' | 'completed' | 'cancelled'
export interface WorkflowNode { kind: string; [key: string]: unknown }
export interface WorkflowDefinition {
  id: string; name?: string; owner?: string; revision: number; enabled: boolean
  source: { kind: 'external' | 'schedule' | 'internal' | 'github-resource'; id: string }
  binding?: { demand?: unknown }; gate: { kind: string; first: 'baseline' | 'emit' }; nodes: WorkflowNode[]
}
export interface WorkflowRun {
  id: string; workflow: string; definition: WorkflowDefinition; timestamp: string; status: WorkflowStatus
  cursor: number; attempts: number; nextAt: number; started: boolean; error?: string
  output?: { sessionId?: string; workKey?: string; stale?: boolean }
}
export interface WorkflowSourceStatus { kind: string; id: string; enabled: boolean; error?: string; nextAt?: number }
export interface WorkflowSnapshot { sources?: WorkflowSourceStatus[]; projectId: string; definitions: WorkflowDefinition[]; runs: WorkflowRun[]; runtimeError?: string }
const statuses = ['queued', 'running', 'retry', 'blocked', 'completed', 'cancelled'] as const
function invalid(): never { throw new Error(t('Workflow state is invalid. Refresh or check Main.')) }
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  if (!isRecord(raw) || !text(raw.id) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || typeof raw.enabled !== 'boolean'
    || !isRecord(raw.source) || !text(raw.source.id) || !['external', 'schedule', 'internal', 'github-resource'].includes(String(raw.source.kind))
    || !isRecord(raw.gate) || raw.gate.kind !== 'revision-dedupe' || !['baseline', 'emit'].includes(String(raw.gate.first))
    || !Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 8 || raw.nodes.some(n => !isRecord(n) || !text(n.kind))
    || raw.name !== undefined && !text(raw.name) || raw.owner !== undefined && !text(raw.owner)) return invalid()
  return raw as unknown as WorkflowDefinition
}
export function parseWorkflows(raw: unknown, projectId: string): WorkflowSnapshot {
  if (!isRecord(raw) || raw.projectId !== projectId || !Array.isArray(raw.definitions) || !Array.isArray(raw.runs)) return invalid()
  const definitions = raw.definitions.map(parseWorkflowDefinition)
  const runs = raw.runs.map((r): WorkflowRun => {
    if (!isRecord(r) || !text(r.id) || !text(r.workflow) || !text(r.timestamp) || !Number.isFinite(Date.parse(r.timestamp))
      || !statuses.includes(r.status as WorkflowStatus) || !Number.isSafeInteger(r.cursor) || Number(r.cursor) < 0
      || !Number.isSafeInteger(r.attempts) || Number(r.attempts) < 0 || typeof r.nextAt !== 'number' || !Number.isFinite(r.nextAt)
      || typeof r.started !== 'boolean' || r.error !== undefined && !text(r.error)) return invalid()
    const definition = parseWorkflowDefinition(r.definition)
    if (definition.id !== r.workflow || Number(r.cursor) > definition.nodes.length) return invalid()
    if (r.output !== undefined && (!isRecord(r.output) || r.output.sessionId !== undefined && !text(r.output.sessionId)
      || r.output.workKey !== undefined && !text(r.output.workKey) || r.output.stale !== undefined && typeof r.output.stale !== 'boolean')) return invalid()
    return { ...r, definition } as unknown as WorkflowRun
  })
  if (new Set(definitions.map(d => d.id)).size !== definitions.length || new Set(runs.map(r => r.id)).size !== runs.length) return invalid()
  const sources = raw.sources === undefined ? [] : raw.sources
  if (!Array.isArray(sources) || sources.some(s => !isRecord(s) || !text(s.kind) || !text(s.id) || typeof s.enabled !== 'boolean' || s.error !== undefined && !text(s.error) || s.nextAt !== undefined && (typeof s.nextAt !== 'number' || !Number.isFinite(s.nextAt)))) return invalid()
  return { projectId, definitions, runs, sources: sources as WorkflowSourceStatus[], runtimeError: typeof raw.runtimeError === 'string' ? raw.runtimeError : undefined }
}
export function workflowStatus(status: WorkflowStatus | 'paused' | 'ready' | 'waiting' | 'received' | 'accepted') {
  const labels: Record<typeof status, MessageKey> = { queued: 'Queued', running: 'Running', retry: 'Retry pending', blocked: 'Blocked', completed: 'Completed', cancelled: 'Cancelled', paused: 'Paused', ready: 'Ready', waiting: 'Waiting', received: 'Received', accepted: 'Accepted' }
  return t(labels[status])
}
export function workflowHint(error?: string): string {
  if (error === 'interrupted_effect') return t('The effect may have happened. Inspect its destination before confirming a retry; duplicate effects are possible.')
  if (error === 'authority_unavailable') return t('Source or owner authorization is unavailable. Restore the exact authorized binding in chat before retrying.')
  if (error === 'mapping_conflict') return t('A Work field or mapping conflicts with local changes. Reconcile ownership in chat before retrying.')
  return t('The action failed. Inspect the source and node configuration in chat. Safe retries use bounded backoff.')
}
export function nodeLabel(kind: string): string {
  const labels: Record<string, MessageKey> = { 'github-notify': 'GitHub → Session inbox', transform: 'Transform', inbox: 'Session inbox', record: 'Record', 'work-map': 'Map to Work', 'schedule-action': 'Schedule action', 'host-action': 'Host action', 'revision-dedupe': 'Revision gate' }
  return labels[kind] ? t(labels[kind]) : kind
}
export function workflowGraph(definition: WorkflowDefinition, run?: WorkflowRun) {
  const status = (index: number) => !run ? 'ready' as const : index < run.cursor ? 'completed' as const
    : index > run.cursor ? 'waiting' as const : run.status
  return [
    { id: 'source', label: t('Signal source'), detail: `${definition.source.kind} · ${definition.source.id}`, status: run ? 'received' as const : 'ready' as const, config: definition.source },
    { id: 'gate', label: nodeLabel(definition.gate.kind), detail: definition.gate.first, status: run ? 'accepted' as const : 'ready' as const, config: definition.gate },
    ...definition.nodes.map((node, i) => ({ id: `node-${i}`, label: nodeLabel(node.kind), detail: node.kind === 'github-notify' && isRecord(node.subscription) ? `${node.subscription.sessionId} · ${node.subscription.workKey} · r${node.subscription.assignmentRevision}` : String(i + 1), status: status(i), config: node })),
  ]
}
export const recentWorkflowRuns = (snapshot: WorkflowSnapshot, id: string) => snapshot.runs.filter(r => r.workflow === id).sort((a, b) => b.timestamp.localeCompare(a.timestamp) || b.id.localeCompare(a.id)).slice(0, 30)
export function createWorkflowClient(base: string, projectId: string, request: typeof fetch = fetch) {
  return {
    async read(signal: AbortSignal) { return parseWorkflows(await projectJson(base, '/api/workflows', { signal }, request), projectId) },
    async control(id: string, action: 'pause' | 'resume' | 'retry' | 'cancel', acknowledgeReplay: boolean, signal: AbortSignal) {
      await projectJson(base, '/api/workflows/control', { method: 'POST', signal, body: JSON.stringify({ id, action, acknowledgeReplay }) }, request)
    },
  }
}
