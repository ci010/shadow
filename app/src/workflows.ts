import { scheduleNodeDelivery } from '../../src/cron/delivery.ts'
import { parseBotProjection, type BotProjection } from './bot-workflows.ts'
import { t, type MessageKey } from './i18n.ts'
import { formatWorkflowSchedule } from './workflow-schedule.ts'
import { isRecord } from './folders-sidebar.ts'
import { projectJson } from './projects.ts'
import { automationChatLocation, type AutomationSummary } from './automations.ts'
import { workflowAutomation } from './workflow-automation.ts'

export type WorkflowStatus = 'queued' | 'running' | 'retry' | 'blocked' | 'completed' | 'cancelled'
export interface WorkflowNode { kind: string; [key: string]: unknown }
export interface WorkflowDefinition {
  id: string; name?: string; owner?: string; revision: number; enabled: boolean
  source: { kind: 'external' | 'schedule' | 'internal' | 'github-resource'; id: string }
  binding?: { demand?: unknown }; gate?: { kind: string; first: 'baseline' | 'emit' }; nodes: WorkflowNode[]
}
export interface WorkflowRun {
  id: string; workflow: string; definition: WorkflowDefinition; timestamp: string; status: WorkflowStatus
  cursor: number; attempts: number; nextAt: number; started: boolean; error?: string
  output?: { sessionId?: string; workKey?: string; stale?: boolean }
}
export interface WorkflowSourceStatus { kind: string; id: string; enabled: boolean; error?: string; nextAt?: number }
export interface WorkflowSnapshot { bots?: BotProjection; botsUnavailable?: boolean; sources?: WorkflowSourceStatus[]; projectId: string; definitions: WorkflowDefinition[]; runs: WorkflowRun[]; runtimeError?: string }
const statuses = ['queued', 'running', 'retry', 'blocked', 'completed', 'cancelled'] as const
function invalid(): never { throw new Error(t('Workflow state is invalid. Refresh or check Main.')) }
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
export function parseWorkflowDefinition(raw: unknown): WorkflowDefinition {
  if (!isRecord(raw) || !text(raw.id) || !Number.isSafeInteger(raw.revision) || Number(raw.revision) < 1 || typeof raw.enabled !== 'boolean'
    || !isRecord(raw.source) || !text(raw.source.id) || !['external', 'schedule', 'internal', 'github-resource'].includes(String(raw.source.kind))
    || raw.gate !== undefined && (!isRecord(raw.gate) || raw.gate.kind !== 'revision-dedupe' || !['baseline', 'emit'].includes(String(raw.gate.first)))
    || !Array.isArray(raw.nodes) || !raw.nodes.length || raw.nodes.length > 8 || raw.nodes.some(n => !isRecord(n) || !text(n.kind))
    || raw.name !== undefined && !text(raw.name) || raw.owner !== undefined && !text(raw.owner)) return invalid()
  if (raw.nodes.some(node => node.kind === 'schedule-action' && node.delivery !== undefined && !scheduleNodeDelivery(node))) return invalid()
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
  return { projectId, definitions, runs, bots: raw.bots === undefined ? undefined : parseBotProjection(raw.bots), botsUnavailable: raw.botsUnavailable === true, sources: sources as WorkflowSourceStatus[], runtimeError: typeof raw.runtimeError === 'string' ? raw.runtimeError : undefined }
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
  const labels: Record<string, MessageKey> = { 'github-notify': 'GitHub → Session inbox', transform: 'Transform', inbox: 'Session inbox', record: 'Record', 'work-map': 'Map to Work', 'schedule-action': 'Schedule action', 'host-action': 'Host action', 'revision-dedupe': 'Deduplicate observations' }
  return labels[kind] ? t(labels[kind]) : kind
}
const recordedText = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined
function actionPresentation(node: WorkflowNode, definition: WorkflowDefinition) {
  const job = isRecord(node.job) ? node.job : undefined
  if (node.kind === 'schedule-action') {
    const task = recordedText(job?.task) ?? recordedText(job?.name)
    const delivery = scheduleNodeDelivery(node)
    if (delivery?.kind === 'session') return { label: t('Deliver to fixed session'), detail: `${t('Reuse context')} · ${delivery.sessionId}`, description: task }
    if (delivery?.kind === 'automation') {
      const strategy = isRecord(job?.program) ? recordedText(job.program.kind) : job?.source === 'learning' ? t('Learning program') : recordedText(job?.agentType)
      return { label: t('Deliver to automation'), detail: t('Fresh context each run'), description: [task, strategy].filter(Boolean).join(' · ') }
    }
    return { label: t('Schedule action'), detail: t('Session policy not recorded'), description: task }
  }
  if (node.kind === 'github-notify' && isRecord(node.subscription)) return { label: nodeLabel(node.kind), detail: recordedText(node.subscription.sessionId) ?? t('Target not recorded'), description: recordedText(node.subscription.workKey) }
  if (node.kind === 'inbox') return { label: t('Deliver to owner inbox'), detail: definition.owner ?? t('Target not recorded') }
  if (node.kind === 'host-action') return { label: t('Host action'), detail: recordedText(node.handler) ?? t('Handler not recorded') }
  if (node.kind === 'work-map') return { label: nodeLabel(node.kind), detail: t('Project Work records'), description: recordedText(node.objective) }
  if (node.kind === 'record') return { label: nodeLabel(node.kind), detail: t('Workflow records') }
  if (node.kind === 'transform') return { label: nodeLabel(node.kind), detail: t('Transform observations without I/O') }
  return { label: nodeLabel(node.kind), detail: node.kind }
}
export function workflowTargetSession(node: WorkflowNode, definition: WorkflowDefinition): string | undefined {
  if (node.kind === 'inbox') return recordedText(definition.owner)
  if (node.kind === 'github-notify' && isRecord(node.subscription)) return recordedText(node.subscription.sessionId)
  const delivery = scheduleNodeDelivery(node)
  if (delivery?.kind === 'session') return delivery.sessionId
  return undefined
}
export type WorkflowConversation = { sessionId: string; kind: 'fixed' | 'latest' } | { automationId: string; kind: 'automation' }
export function workflowConversationLocation(projectId: string, conversation: WorkflowConversation) {
  return conversation.kind === 'automation' ? automationChatLocation(projectId, conversation.automationId)
    : { name: 'chat', params: { projectId, sessionId: conversation.sessionId } }
}
/** Fixed delivery stays ordinary chat; fresh/managed runs reuse sidebar latest-run navigation. */
export function workflowConversation(definition: WorkflowDefinition, runs: WorkflowRun[], jobs: readonly AutomationSummary[] = []): WorkflowConversation | undefined {
  const fixed = definition.nodes.map(node => workflowTargetSession(node, definition)).find(Boolean)
  if (fixed) return { sessionId: fixed, kind: 'fixed' as const }
  const automation = workflowAutomation(jobs, definition.id)
  if (automation) return { automationId: automation.id, kind: 'automation' }
  if (definition.source.kind === 'schedule' || definition.source.kind === 'internal') return undefined
  const latest = runs.filter(run => run.workflow === definition.id && recordedText(run.output?.sessionId))
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp) || b.id.localeCompare(a.id))[0]
  return latest ? { sessionId: latest.output!.sessionId!, kind: 'latest' as const } : undefined
}
export function workflowGraph(definition: WorkflowDefinition, run?: WorkflowRun) {
  const status = (index: number) => !run ? 'ready' as const : index < run.cursor ? 'completed' as const
    : index > run.cursor ? 'waiting' as const : run.status
  const scheduleNode = definition.nodes.find(node => node.kind === 'schedule-action')
  const job = isRecord(scheduleNode?.job) ? scheduleNode.job : undefined
  const source = definition.source.kind === 'schedule'
    ? { label: t('Time signal'), detail: recordedText(job?.schedule) ? formatWorkflowSchedule(String(job!.schedule)) : t('Schedule not recorded'), description: recordedText(job?.timezone) ? t('Timezone: {zone}', { zone: String(job?.timezone) }) : undefined }
    : { label: t('Signal source'), detail: `${definition.source.kind} · ${definition.source.id}`, description: undefined }
  return [
    { id: 'source', nodeType: 'source' as const, ...source, status: run ? 'received' as const : 'ready' as const, config: definition.source },
    ...(definition.gate ? [{ id: 'gate', nodeType: 'gate' as const, label: nodeLabel(definition.gate.kind), detail: definition.gate.first === 'baseline' ? t('First collection: baseline only') : t('First collection: emit unseen revisions'), description: t('Skip observations already seen'), status: run ? 'accepted' as const : 'ready' as const, config: definition.gate }] : []),
    ...definition.nodes.map((node, i) => ({ id: `node-${i}`, nodeType: 'action' as const, ...actionPresentation(node, definition), status: status(i), config: node, targetSessionId: workflowTargetSession(node, definition) })),
  ].map(node => ({ targetSessionId: undefined as string | undefined, ...node }))
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
