import { MarkerType, type Node, type Edge } from '@vue-flow/core'
import { workflowGraph, type WorkflowDefinition, type WorkflowRun, type WorkflowConversation } from './workflows.ts'

export interface WorkflowCanvasControl { enabled: boolean; disabled: boolean; busy: boolean; error?: string; notice?: string }
export interface WorkflowCanvasEntry { definition: WorkflowDefinition; run?: WorkflowRun; enabled?: boolean; snapshot?: boolean; conversation?: WorkflowConversation; control?: WorkflowCanvasControl }
const nodeId = (flow: string, node: string) => JSON.stringify([flow, node])

/** A read-only projection. IDs and connections are scoped to their owning workflow. */
export function workflowCanvas(flows: WorkflowCanvasEntry[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [], edges: Edge[] = []
  for (const [row, { definition, run, enabled = definition.enabled, snapshot = false, conversation, control }] of flows.entries()) {
    const graph = workflowGraph(definition, run)
    const groupId = nodeId(definition.id, 'group')
    nodes.push({ id: groupId, type: 'group', position: { x: 0, y: row * 260 }, data: { definition, run, enabled, snapshot, conversation, control },
      style: { width: `${graph.length * 280 + 24}px`, height: '240px' },
      draggable: false, selectable: false, connectable: false, deletable: false, focusable: false, zIndex: -1 })
    for (const [index, node] of graph.entries()) {
      nodes.push({ id: nodeId(definition.id, node.id), type: 'workflow',
        parentNode: groupId, extent: 'parent', position: { x: 24 + index * 280, y: 64 }, data: { ...node, flowId: definition.id, enabled },
        draggable: false, connectable: false, deletable: false, selectable: false, focusable: false })
      if (index) edges.push({
        id: nodeId(definition.id, `edge-${index}`), source: nodeId(definition.id, graph[index - 1]!.id), target: nodeId(definition.id, node.id), type: 'smoothstep',
        markerEnd: { type: MarkerType.ArrowClosed, color: 'var(--c-text-muted)' },
        animated: run?.status === 'running',
        style: { stroke: run?.status === 'running' ? 'var(--c-info)' : 'var(--c-text-muted)', strokeDasharray: enabled ? undefined : '6 4' }, selectable: false, deletable: false, focusable: false,
      })
    }
  }
  return { nodes, edges }
}
