import { overviewNodeWidth } from './project-overview-graph.ts'

/** Restore the pre-expansion scale, centering the owner in the usable canvas. */
export function collapsedTopicViewport(position: { x: number; y: number }, zoom: number, area: { width: number; height: number; top: number }) {
  return {
    x: area.width / 2 - (position.x + overviewNodeWidth / 2) * zoom,
    y: area.top + (area.height - area.top) / 2 - (position.y + 112 / 2) * zoom,
    zoom,
  }
}
