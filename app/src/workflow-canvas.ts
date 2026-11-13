import { MarkerType, type Node, type Edge } from '@vue-flow/core'
import { workflowGraph, type WorkflowDefinition, type WorkflowRun, type WorkflowConversation } from './workflows.ts'

export interface WorkflowCanvasControl { enabled: boolean; disabled: boolean; busy: boolean; error?: string; notice?: string }
export type WorkflowNodeType = 'connection' | 'binding' | 'deployment' | 'session' | 'source' | 'gate' | 'action'
type ProjectionGraph = Array<{ id: string; nodeType?: WorkflowNodeType; label: string; detail: string; config: unknown; status: 'ready'; description?: string; targetSessionId?: string }>
export type WorkflowCanvasEntry = ({ definition: WorkflowDefinition; graph?: never; projection?: false } |
  { definition: Pick<WorkflowDefinition, 'id' | 'name' | 'enabled'>; graph: ProjectionGraph; projection: true }) &
  { run?: WorkflowRun; enabled?: boolean; snapshot?: boolean; conversation?: WorkflowConversation; control?: WorkflowCanvasControl; configureConnectionId?: string }
export const workflowColumns = ['cron', 'automation', 'bot'] as const
export type WorkflowColumn = typeof workflowColumns[number]
/** Managed automations also use CronService's schedule adapter. Classify their
 * saved product metadata, not names, IDs, schedule expressions or session policy. */
export function workflowColumn(entry: WorkflowCanvasEntry): WorkflowColumn {
  if (entry.projection) return 'bot'
  if (entry.definition.source.kind !== 'schedule') return 'automation'
  const node = entry.definition.nodes.find(node => node.kind === 'schedule-action')
  const job = node?.job
  if (node?.action === 'program' || isRecord(job) && (job.program != null || job.source === 'learning' || job.source === 'system')) return 'automation'
  return 'cron'
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
const nodeId = (flow: string, node: string) => JSON.stringify([flow, node])

/** A read-only projection. IDs and connections are scoped to their owning workflow. */
export function workflowCanvas(flows: WorkflowCanvasEntry[]): { nodes: Node[]; edges: Edge[] } {
  const nodes: Node[] = [], edges: Edge[] = []
  if (!flows.length) return { nodes, edges }
  const entries = flows.map(entry => ({ entry, column: workflowColumn(entry), graph: entry.graph ?? workflowGraph(entry.definition as WorkflowDefinition, entry.run) }))
  const widths = Object.fromEntries(workflowColumns.map(column => [column, Math.max(304, ...entries.filter(item => item.column === column).map(item => item.graph.length * 280 + 24))])) as Record<WorkflowColumn, number>
  const positions = {} as Record<WorkflowColumn, number>
  const rows = { cron: 0, automation: 0, bot: 0 }
  let x = 0
  for (const column of workflowColumns) {
    positions[column] = x
    nodes.push({ id: JSON.stringify(['workflow-column', column, 'heading']), type: 'column', position: { x, y: 0 }, data: { column },
      style: { width: `${widths[column]}px`, height: '32px' },
      draggable: false, selectable: false, connectable: false, deletable: false, focusable: false })
    x += widths[column] + 64
  }
  for (const { entry, column, graph } of entries) {
    const { definition, run, enabled = definition.enabled, snapshot = false, conversation, control } = entry
    const row = rows[column]++
    const groupId = nodeId(definition.id, 'group')
    nodes.push({ id: groupId, type: 'group', position: { x: positions[column], y: 48 + row * 260 }, data: { definition, run, enabled, snapshot, conversation, control, configureConnectionId: entry.configureConnectionId, projection: entry.projection, projectionType: entry.projection ? graph.find(node => node.nodeType === 'binding')?.nodeType ?? graph[0]?.nodeType : undefined, column },
      style: { width: `${graph.length * 280 + 24}px`, height: '240px' },
      draggable: false, selectable: false, connectable: false, deletable: false, focusable: false, zIndex: -1 })
    for (const [index, node] of graph.entries()) {
      nodes.push({ id: nodeId(definition.id, node.id), type: 'workflow',
        parentNode: groupId, extent: 'parent', position: { x: 24 + index * 280, y: 64 }, data: { ...node, flowId: definition.id, enabled, projection: entry.projection, column },
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
