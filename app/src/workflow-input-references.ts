import { configuredTarget } from './bot-workflows.ts'
import { t } from './i18n.ts'
import type { WorkflowCanvasEntry } from './workflow-canvas.ts'
import { receiverLabel } from './receiver-label.ts'
import type { InjectionKey } from 'vue'
import { parseInputReferences, type InputReference, type WorkflowReferenceSelector } from '../../src/shared/input-references.ts'
import type { WorkflowDefinition, WorkflowRun } from './workflows.ts'

export interface LabeledInputReference { reference: InputReference; label: string }
export type AttachReferenceResult = 'added' | 'duplicate' | 'limit' | 'unavailable'
export interface WorkflowInputReferences {
  attach(item: LabeledInputReference): AttachReferenceResult
  select?(item: LabeledInputReference | undefined, clear?: () => void, projectId?: string): void
  selection?(projectId: string, owner: string, sessionId: string): LabeledInputReference | undefined
  clearSelection?(): void
}
export const WorkflowInputReferencesKey: InjectionKey<WorkflowInputReferences> = Symbol('WorkflowInputReferences')
export const inputReferenceKey = (item: InputReference): string => item.kind === 'bot-deployment'
  ? JSON.stringify([item.kind, item.projectId, item.botId, item.revision, item.bindingId ?? null, item.selector ?? null]) : item.kind === 'connection-sink'
  ? JSON.stringify([item.kind, item.projectId, item.connectionId, item.receiverId ?? null]) : JSON.stringify([item.projectId, item.workflowId, item.revision, item.runId ?? null,
  item.selector?.kind === 'node' ? ['node', item.selector.index, item.selector.nodeKind] : item.selector?.kind ?? null])

/** Resolve graph-local IDs against the displayed admitted definition, never canvas IDs. */
export function workflowInputReference(projectId: string, definition: WorkflowDefinition, nodeId?: string, run?: WorkflowRun): LabeledInputReference | undefined {
  if (run && (run.workflow !== definition.id || run.definition.revision !== definition.revision)) return
  let selector: WorkflowReferenceSelector | undefined
  let detail = ''
  if (nodeId === 'source') { selector = { kind: 'source' }; detail = 'source' }
  else if (nodeId === 'gate' && definition.gate) { selector = { kind: 'gate' }; detail = 'gate' }
  else if (nodeId !== undefined) {
    const match = /^node-([0-7])$/.exec(nodeId)
    if (!match) return
    const index = Number(match[1]), node = definition.nodes[index]
    if (!node) return
    selector = { kind: 'node', index, nodeKind: node.kind as Extract<WorkflowReferenceSelector, { kind: 'node' }>['nodeKind'] }
    detail = `${index + 1}: ${node.kind}`
  }
  try {
    const [reference] = parseInputReferences([{ kind: 'workflow', projectId, workflowId: definition.id, revision: definition.revision,
      ...(run ? { runId: run.id } : {}), ...(selector ? { selector } : {}) }])
    return { reference: reference!, label: `${definition.name || definition.id}${detail ? ` · ${detail}` : ''} · r${definition.revision}${run ? ` · ${run.id}` : ''}` }
  } catch { return }
}

export function connectionSinkInputReference(projectId: string, connectionId: string, label: string, receiverId?: string): LabeledInputReference {
  const [reference] = parseInputReferences([{ kind: 'connection-sink', projectId, connectionId, ...(receiverId ? { receiverId } : {}) }])
  return { reference: reference!, label }
}

export function addInputReference(items: readonly LabeledInputReference[], item: LabeledInputReference): { items: LabeledInputReference[]; result: AttachReferenceResult } {
  const [reference] = parseInputReferences([item.reference])
  if (items.some(existing => inputReferenceKey(existing.reference) === inputReferenceKey(reference!))) return { items: [...items], result: 'duplicate' }
  if (items.length >= 8) return { items: [...items], result: 'limit' }
  return { items: [...items, { label: item.label, reference: reference! }], result: 'added' }
}

/** Capture a detached wire payload before any session preparation or upload awaits. */
export function captureInputReferences(items: readonly LabeledInputReference[]): InputReference[] {
  return parseInputReferences(items.map(item => item.reference))
}
export function removeSentInputReferences(items: readonly LabeledInputReference[], sent: readonly InputReference[]): LabeledInputReference[] {
  const keys = new Set(sent.map(inputReferenceKey))
  return items.filter(item => !keys.has(inputReferenceKey(item.reference)))
}

/** Selection cannot silently widen to the parent Connection or receiver. */
export function botInputReference(projectId: string, entry: WorkflowCanvasEntry, nodeId?: string): LabeledInputReference | undefined {
  const node = entry.graph?.find(node => node.id === (nodeId ?? (!entry.sinkProjection && entry.graph?.length === 1 ? entry.graph[0]?.id : undefined)))
  const sink = entry.sinkProjection
  if (node?.nodeType === 'deployment' || nodeId?.startsWith('entry:')) {
    const botNode = node?.nodeType === 'deployment' ? node : entry.graph?.find(item => item.parentId === nodeId && item.nodeType === 'deployment')
    const config = botNode?.config as { id?: string; platform?: string; topic?: string; kind?: string; deployment?: { id: string; revision?: string; state: string; agent?: string } } | undefined
    const bot = config?.deployment
    if (!bot?.revision || bot.state !== 'valid') return
    try {
      const [reference] = parseInputReferences([{ kind: 'bot-deployment', projectId, botId: bot.id, revision: bot.revision,
        ...(config?.id ? { bindingId: config.id } : {}), ...(nodeId?.startsWith('entry:') ? { selector: 'entry' } : {}) }])
      const target = config?.id ? config.kind === 'host-owner-ingress' ? t('Host owner ingress') : configuredTarget({ platform: config.platform ?? '', topic: config.topic, kind: config.kind ?? '' }) : ''
      return { reference: reference!, label: `${bot.agent || bot.id} · ${bot.id}${target ? ` · ${target}` : ''}${nodeId?.startsWith('entry:') ? ` · ${t('Conversation entry')}` : ''}` }
    } catch { return }
  }
  if (!sink) return
  if (nodeId?.startsWith('receiver:')) {
    const receiver = sink.receivers.find(receiver => receiver.id === nodeId.slice('receiver:'.length))
    return receiver ? connectionSinkInputReference(projectId, sink.connectionId, receiverLabel(receiver), receiver.id) : undefined
  }
  if (nodeId !== undefined && nodeId !== 'connection') return
  return connectionSinkInputReference(projectId, sink.connectionId, entry.definition.name || sink.connectionId)
}
