import type { OtioModel, OtioNode } from './otio-model.ts'

export function lastOtioFrame(duration: number, rate: number): number {
  const frames = duration * rate
  if (!Number.isFinite(frames)) return 0
  // Remove floating-point noise around an integral, exclusive end frame.
  const nearest = Math.round(frames)
  const end = Math.abs(nearest - frames) <= Number.EPSILON * Math.max(1, frames) * 4 ? nearest : frames
  return Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(end) - 1))
}

export function scrubOtioFrame(fraction: number, duration: number, rate: number): number {
  return Math.max(0, Math.min(lastOtioFrame(duration, rate), Math.round(fraction * duration * rate)))
}

export function otioPercent(seconds: number, duration: number): number {
  return duration > 0 ? Math.max(0, Math.min(100, seconds / duration * 100)) : 0
}

export function visibleOtioNodes(nodes: readonly OtioNode[], collapsed: ReadonlySet<string>): OtioNode[] {
  let hiddenBelow = Infinity
  return nodes.filter(node => {
    if (node.depth > hiddenBelow) return false
    hiddenBelow = collapsed.has(node.id) ? node.depth : Infinity
    return true
  })
}

export interface OtioLane {
  node: OtioNode
  items: OtioNode[]
}

export function otioLanes(model: OtioModel): OtioLane[] {
  const lanes = new Map<string, OtioLane>()
  const byId = new Map(model.nodes.map(node => [node.id, node]))
  const owners = new Map<string, OtioLane | undefined>()
  for (const node of model.nodes) {
    const parent = node.parentId === null ? undefined : byId.get(node.parentId)
    const inheritedLane = parent ? owners.get(parent.id) : undefined
    // Stack siblings are parallel rather than sequential. Give each branch its
    // own lane so an overlapping sibling can never intercept a clip's click.
    const lane = node.kind === 'Track' || parent?.kind === 'Stack' || !inheritedLane
      ? { node, items: [] }
      : inheritedLane
    if (node.kind === 'Track') {
      lanes.set(node.id, lane)
    } else if (node.kind === 'Clip' || node.kind === 'Gap' || node.kind === 'Transition') {
      lanes.set(lane.node.id, lane)
      lane.items.push(node)
    }
    owners.set(node.id, lane)
  }
  return [...lanes.values()]
}
