export type AnswerStatus = 'implemented' | 'proposed' | 'unverified'
export interface AnswerFlowNode { id: string; label: string; detail?: string; status?: AnswerStatus; group?: string; placement?: { row: number; column: number } }
export interface AnswerFlowEdge { source: string; target: string; label?: string; status?: AnswerStatus }
export interface AnswerFlow { version: 1; title?: string; summary?: string; direction: 'TB' | 'LR'; layout?: { mode: 'auto' | 'relative' }; height: number; nodes: AnswerFlowNode[]; edges: AnswerFlowEdge[]; groups: { id: string; label: string }[] }
export const ANSWER_FLOW_SOURCE_LIMIT = 65536
const status = ['implemented', 'proposed', 'unverified']
function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k))) throw Error('Unsupported diagram fields')
  return value as Record<string, unknown>
}
function text(value: unknown, max: number, required = false): string | undefined {
  if (value === undefined && !required) return undefined
  if (typeof value !== 'string' || value.length > max || (required && !value.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) throw Error('Invalid or oversized diagram text')
  return value
}
function list(value: unknown, max: number): unknown[] { if (!Array.isArray(value) || value.length > max) throw Error('Invalid or oversized diagram list'); return value }
function state(value: unknown): AnswerStatus | undefined { if (value === undefined) return undefined; if (!status.includes(value as string)) throw Error('Invalid diagram status'); return value as AnswerStatus }
function placement(value: unknown, mode: 'auto' | 'relative'): AnswerFlowNode['placement'] {
  if (mode === 'auto') { if (value !== undefined) throw Error('Placement requires relative layout'); return undefined }
  const p = object(value, ['row', 'column'])
  if (![p.row, p.column].every(v => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 20)) throw Error('Placement row/column must be integers 0–20')
  return { row: p.row as number, column: p.column as number }
}
export function parseAnswerFlow(source: string): AnswerFlow {
  if (source.length > ANSWER_FLOW_SOURCE_LIMIT || new TextEncoder().encode(source).byteLength > ANSWER_FLOW_SOURCE_LIMIT) throw Error('Diagram exceeds 64 KiB')
  let raw: unknown
  try { raw = JSON.parse(source) } catch { throw Error('Diagram JSON is incomplete or invalid') }
  const v = object(raw, ['version', 'title', 'summary', 'direction', 'height', 'nodes', 'edges', 'groups', 'layout'])
  if (v.version !== 1) throw Error('Diagram version must be 1')
  if (v.direction !== undefined && v.direction !== 'TB' && v.direction !== 'LR') throw Error('Direction must be TB or LR')
  if (v.height !== undefined && (typeof v.height !== 'number' || !Number.isInteger(v.height) || v.height < 240 || v.height > 640)) throw Error('Height must be 240–640')
  const mode = v.layout === undefined ? 'auto' : object(v.layout, ['mode']).mode
  if (mode !== 'auto' && mode !== 'relative') throw Error('Layout mode must be auto or relative')
  const groups = list(v.groups ?? [], 12).map(raw => { const g = object(raw, ['id', 'label']); return { id: text(g.id, 64, true)!, label: text(g.label, 160, true)! } })
  const nodes = list(v.nodes, 60).map(raw => { const n = object(raw, ['id', 'label', 'detail', 'status', 'group', 'placement']); return { id: text(n.id, 64, true)!, label: text(n.label, 160, true)!, detail: text(n.detail, 2000), status: state(n.status), group: text(n.group, 64), placement: placement(n.placement, mode) } })
  if (!nodes.length) throw Error('Diagram needs at least one node')
  const ids = new Set(nodes.map(n => n.id)), groupIds = new Set(groups.map(g => g.id))
  if (ids.size !== nodes.length || groupIds.size !== groups.length) throw Error('Diagram IDs must be unique')
  if (nodes.some(n => n.group !== undefined && !groupIds.has(n.group))) throw Error('Unknown node group')
  const cells = new Set<string>()
  for (const n of nodes) if (n.placement) {
    const cell = JSON.stringify([n.group ?? null, n.placement.row, n.placement.column])
    if (cells.has(cell)) throw Error('Duplicate placement cell within group')
    cells.add(cell)
  }
  const edges = list(v.edges, 120).map(raw => { const e = object(raw, ['source', 'target', 'label', 'status']); return { source: text(e.source, 64, true)!, target: text(e.target, 64, true)!, label: text(e.label, 160), status: state(e.status) } })
  if (edges.some(e => !ids.has(e.source) || !ids.has(e.target))) throw Error('Unknown edge endpoint')
  return { version: 1, title: text(v.title, 160), summary: text(v.summary, 2000), direction: v.direction === 'LR' ? 'LR' : 'TB', layout: { mode }, height: v.height as number ?? 400, nodes, edges, groups }
}
/** Cycle-safe deterministic layering. Group lanes remain non-overlapping even for cross-group edges. */
export function layoutAnswerFlow(flow: AnswerFlow) {
  const ranks = new Map(flow.nodes.map(n => [n.id, 0]))
  // Condense strongly connected nodes by reachability (bounded at 60 nodes).
  const reachable = new Map(flow.nodes.map(n => [n.id, new Set([n.id])]))
  for (const e of flow.edges) reachable.get(e.source)!.add(e.target)
  for (const k of flow.nodes) for (const i of flow.nodes) if (reachable.get(i.id)!.has(k.id)) for (const j of reachable.get(k.id)!) reachable.get(i.id)!.add(j)
  for (let pass = 0; pass < flow.nodes.length; pass++) {
    for (const e of flow.edges) if (!reachable.get(e.target)!.has(e.source)) ranks.set(e.target, Math.max(ranks.get(e.target)!, ranks.get(e.source)! + 1))
    // Align SCC peers before propagating to downstream layers.
    for (const n of flow.nodes) for (const other of flow.nodes) if (reachable.get(n.id)!.has(other.id) && reachable.get(other.id)!.has(n.id)) {
      const rank = Math.max(ranks.get(n.id)!, ranks.get(other.id)!); ranks.set(n.id, rank); ranks.set(other.id, rank)
    }
  }
  const positions = new Map<string, { x: number; y: number }>()
  const bounds: { id: string; label: string; x: number; y: number; width: number; height: number }[] = []
  let laneOffset = 0
  for (const group of [...flow.groups, { id: undefined, label: '' }]) {
    const members = flow.nodes.filter(n => n.group === group.id)
    if (!members.length) continue
    const slots = new Map<number, number>(); let maxSlot = 0, maxRank = 0
    for (const n of members) {
      const rank = ranks.get(n.id)!, slot = slots.get(rank) ?? 0; slots.set(rank, slot + 1)
      maxSlot = Math.max(maxSlot, slot + 1); maxRank = Math.max(maxRank, rank)
      positions.set(n.id, flow.direction === 'TB' ? { x: laneOffset + 24 + slot * 240, y: 56 + rank * 160 } : { x: 24 + rank * 280, y: laneOffset + 56 + slot * 120 })
    }
    if (flow.layout?.mode === 'relative') {
      maxSlot = 0; maxRank = 0
      for (const n of members) {
        const { row, column } = n.placement!
        positions.set(n.id, { x: 24 + column * 240 + (flow.direction === 'TB' ? laneOffset : 0), y: 56 + row * 160 + (flow.direction === 'LR' ? laneOffset : 0) })
        maxSlot = Math.max(maxSlot, column + 1); maxRank = Math.max(maxRank, row + 1)
      }
      const width = maxSlot * 240 + 24, height = maxRank * 160 + 56
      if (group.id !== undefined) bounds.push({ id: group.id, label: group.label, x: flow.direction === 'TB' ? laneOffset : 0, y: flow.direction === 'TB' ? 0 : laneOffset, width, height })
      laneOffset += (flow.direction === 'TB' ? width : height) + 32
      continue
    }
    const width = flow.direction === 'TB' ? maxSlot * 240 + 24 : (maxRank + 1) * 280
    const height = flow.direction === 'TB' ? (maxRank + 1) * 160 + 24 : maxSlot * 120 + 56
    if (group.id !== undefined) bounds.push({ id: group.id, label: group.label, x: flow.direction === 'TB' ? laneOffset : 0, y: flow.direction === 'TB' ? 0 : laneOffset, width, height })
    laneOffset += (flow.direction === 'TB' ? width : height) + 32
  }
  return { positions, bounds }
}
