// Graph layout is in world units; rendering and hit targets are in CSS pixels.
export interface GraphPoint { id: string; title: string; x: number; y: number }
export function graphScale(width: number, height: number, worldWidth: number, worldHeight: number, zoom: number) {
  return Math.max(.001, Math.min(Math.max(1, width - 80) / worldWidth, Math.max(1, height - 160) / worldHeight) * zoom / 100)
}
export function graphLabels(nodes: GraphPoint[], width: number, height: number, selected: string, hovered: string, neighbors: Set<string>, degrees: Map<string, number>) {
  const result = new Set<string>()
  const boxes: { x: number; y: number; w: number }[] = []
  const priority = (id: string) => id === hovered ? 4 : id === selected ? 3 : selected && neighbors.has(id) ? 2 : 1
  const budget = Math.max(2, Math.min(24, Math.floor(width * height / 22000)))
  const candidates = [...nodes].sort((a, b) => priority(b.id) - priority(a.id) || (degrees.get(b.id) ?? 0) - (degrees.get(a.id) ?? 0) || a.id.localeCompare(b.id))
  for (const node of candidates) {
    if (node.x < 12 || node.y < 60 || node.x > width - 30 || node.y > height - 40) continue
    if (result.size >= budget && priority(node.id) < 3) continue
    if (selected && !neighbors.has(node.id) && priority(node.id) < 3) continue
    const labelWidth = [...node.title.slice(0, 28)].reduce((sum, char) => sum + (char.charCodeAt(0) > 255 ? 12 : 7.5), 8)
    const box = { x: node.x > width - 220 ? node.x - 12 - labelWidth : node.x + 12, y: node.y, w: labelWidth }
    if ((box.x < 8 || box.x + box.w > width - 8) && priority(node.id) < 3) continue
    if (boxes.some(other => Math.abs(other.y - box.y) < 20 && box.x < other.x + other.w && box.x + box.w > other.x)) continue
    // Don't lay ordinary labels over another node's hit area.
    if (priority(node.id) < 2 && nodes.some(other => other.id !== node.id && Math.abs(other.y - box.y) < 14 && other.x > box.x - 6 && other.x < box.x + box.w + 6)) continue
    boxes.push(box); result.add(node.id)
  }
  return result
}
