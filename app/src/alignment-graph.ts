export interface AlignmentGraphNode { id: string; label: string; position: { x: number; y: number } }
export interface AlignmentGraphEdge { id: string; source: string; target: string }
export function sampleAlignmentGraph(): { nodes: AlignmentGraphNode[]; edges: AlignmentGraphEdge[] } {
  return {
    nodes: [
      { id: 'brief', label: 'Creative brief', position: { x: 20, y: 150 } },
      { id: 'script', label: 'Script', position: { x: 240, y: 60 } },
      { id: 'references', label: 'Visual references', position: { x: 240, y: 240 } },
      { id: 'shots', label: 'Generate shots', position: { x: 460, y: 150 } },
      { id: 'review', label: 'Human review', position: { x: 680, y: 150 } },
    ],
    edges: [
      { id: 'brief-script', source: 'brief', target: 'script' },
      { id: 'brief-references', source: 'brief', target: 'references' },
      { id: 'script-shots', source: 'script', target: 'shots' },
      { id: 'references-shots', source: 'references', target: 'shots' },
      { id: 'shots-review', source: 'shots', target: 'review' },
    ],
  }
}
export function graphConnectionAllowed(source: string, target: string, nodes: readonly { id: string }[], edges: readonly { source: string; target: string }[]): boolean {
  return source !== target && nodes.some(node => node.id === source) && nodes.some(node => node.id === target)
    && !edges.some(edge => edge.source === source && edge.target === target)
}

export function parseAlignmentGraph(value: unknown): ReturnType<typeof sampleAlignmentGraph> {
  if (!value || typeof value !== 'object') throw new Error('Invalid graph')
  const graph = value as { nodes?: unknown; edges?: unknown }
  if (!Array.isArray(graph.nodes) || !graph.nodes.length || graph.nodes.length > 100 || !Array.isArray(graph.edges) || graph.edges.length > 200) throw new Error('Invalid graph size')
  const id = (value: unknown): string => { if (typeof value !== 'string' || !value.trim() || value.length > 256) throw new Error('Invalid graph ID'); return value }
  const nodes = graph.nodes.map((value, index) => {
    if (!value || typeof value !== 'object') throw new Error('Invalid node')
    const node = value as { id?: unknown; label?: unknown; position?: { x?: unknown; y?: unknown } }
    const label = id(node.label)
    const x = node.position?.x ?? (index % 4) * 220, y = node.position?.y ?? Math.floor(index / 4) * 150
    if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1e6 || Math.abs(y) > 1e6) throw new Error('Invalid graph position')
    return { id: id(node.id), label, position: { x, y } }
  })
  const ids = new Set(nodes.map(node => node.id))
  if (ids.size !== nodes.length) throw new Error('Duplicate node ID')
  const edges = graph.edges.map(value => {
    if (!value || typeof value !== 'object') throw new Error('Invalid edge')
    const edge = value as { id?: unknown; source?: unknown; target?: unknown }
    const parsed = { id: id(edge.id), source: id(edge.source), target: id(edge.target) }
    if (!ids.has(parsed.source) || !ids.has(parsed.target)) throw new Error('Missing graph endpoint')
    return parsed
  })
  if (new Set(edges.map(edge => edge.id)).size !== edges.length) throw new Error('Duplicate edge ID')
  return { nodes, edges }
}
