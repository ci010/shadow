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
export const inputReferenceKey = (item: InputReference): string => JSON.stringify([item.projectId, item.workflowId, item.revision, item.runId ?? null,
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
