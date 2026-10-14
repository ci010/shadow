import { MarkerType, type Edge } from '@vue-flow/core'
import type { OverviewEdge } from './project-overview-graph.ts'
/** Presentation only: persisted evidence and ownership remain in overviewGraph. */
export function overviewFlowEdges(edges: OverviewEdge[], label: (kind: string) => string): Edge[] {
  return edges.map((edge, index) => {
    const color = ({ hierarchy: 'var(--c-blue)', causal: 'var(--c-success)', dependency: 'var(--c-warn)', reconsiders: 'var(--c-error)' } as Record<string, string>)[edge.kind] ?? 'var(--c-text-muted)'
    return { id: `${edge.kind}:${edge.from}:${edge.to}:${index}`, source: (edge as OverviewEdge & { source?: string }).source ?? edge.from, target: (edge as OverviewEdge & { target?: string }).target ?? edge.to, type: 'smoothstep',
      data: edge, class: `overview-edge-${edge.kind}`, selectable: false, deletable: false, focusable: false,
      label: ['causal', 'dependency', 'reconsiders'].includes(edge.kind) ? label(edge.kind) : undefined,
      markerEnd: { type: MarkerType.ArrowClosed, color, width: 14, height: 14 },
      style: { stroke: color, strokeWidth: edge.kind === 'causal' ? 2.5 : 1.5,
        strokeDasharray: edge.kind === 'precedence' ? '3 6' : ['reference', 'context', 'relation'].includes(edge.kind) ? '7 4' : undefined,
        opacity: edge.kind === 'precedence' ? .45 : .85 },
    }
  })
}
