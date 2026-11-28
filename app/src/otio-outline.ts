import type { OtioMarker, OtioModel, OtioNode } from './otio-model.ts'
import { visibleOtioNodes } from './otio-navigation.ts'

/** Outline-only rows: markers never enter the node index or clip selection API. */
export type OtioOutlineRow =
  | { id: string; name: string; kind: string; depth: number; node: OtioNode; marker?: never }
  | { id: string; name: string; kind: 'Marker'; depth: number; marker: OtioMarker; node?: never }

export function otioOutlineRows(model: OtioModel, collapsed: ReadonlySet<string>): OtioOutlineRow[] {
  const markers = new Map<string, OtioMarker[]>()
  for (const marker of model.markers ?? []) {
    const group = markers.get(marker.ownerId) ?? []
    group.push(marker)
    markers.set(marker.ownerId, group)
  }
  return visibleOtioNodes(model.nodes, collapsed).flatMap<OtioOutlineRow>(node => [
    { id: node.id, name: node.name, kind: node.kind, depth: node.depth, node },
    ...(!collapsed.has(node.id) ? (markers.get(node.id) ?? []).map(marker => ({
      id: marker.id, name: marker.name, kind: 'Marker' as const, depth: node.depth + 1, marker,
    })) : []),
  ])
}
